import crypto from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import express from 'express';
import { AddressInfo } from 'net';
import { createGateway } from '../src/app';
import { IP_RULES_KEY, IP_RULES_VERSION_KEY, IpDenyList, RedisIpRuleSource } from '../src/ip-rules';

/**
 * The edge-Redis contract against a real Redis (the GCRA Lua script, ban keys, the IP rules mirror). Set
 * REDIS_TEST_URL to a scratch instance to run it; it is skipped otherwise. It writes the shared edge keys
 * (edge:ip-rules, edge:ban:<test address>), so never point it at a Redis serving real traffic.
 */
const url = process.env.REDIS_TEST_URL;
const describeRedis = url ? describe : describe.skip;

describeRedis('gateway against a real edge Redis', () => {
  let redis: Redis;
  let upstream: ReturnType<express.Express['listen']>;
  let upstreamUrl: string;
  const testIp = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

  beforeAll(async () => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
    const app = express();
    app.all('*', (_req, res) => res.json({ ok: true }));
    upstream = app.listen(0);
    await new Promise((r) => upstream.once('listening', r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await redis.del(`edge:ban:${testIp}`);
    await redis.quit();
    upstream.close();
  });

  const gateway = (ipDenyList: IpDenyList | null = null) =>
    createGateway({
      routes: [{ name: 'transaction-service', prefix: '/api/v1/transactions', target: upstreamUrl }],
      redis,
      ipDenyList,
      trustProxy: 1,
      limits: {
        ip: { name: `ip-${testIp}`, limit: 60, periodMs: 60_000, burst: 3 },
        user: { name: 'user', limit: 60, periodMs: 60_000, burst: 3 },
        moneyWrite: { name: 'money-write', limit: 60, periodMs: 60_000, burst: 3 },
        assistant: { name: 'assistant', limit: 60, periodMs: 60_000, burst: 3 },
        webhook: { name: 'webhook', limit: 60, periodMs: 60_000, burst: 3 },
      },
    });

  it('limits with the GCRA script and refuses banned addresses in the same call', async () => {
    const app = gateway();
    const call = () => request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', testIp);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);

    await redis.set(`edge:ban:${testIp}`, JSON.stringify({ reason: 'CREDENTIAL_STUFFING' }), 'EX', 60);
    const banned = await call();
    expect(banned.status).toBe(403);
    expect(banned.body.error.code).toBe('IP_BLOCKED');
    expect(Number(banned.headers['retry-after'])).toBeGreaterThan(55);
  });

  it('loads deny rules from the mirror written by auth-service', async () => {
    const previous = { rules: await redis.hgetall(IP_RULES_KEY), version: await redis.get(IP_RULES_VERSION_KEY) };
    try {
      await redis
        .multi()
        .del(IP_RULES_KEY)
        .hset(IP_RULES_KEY, 'rule-1', JSON.stringify({ cidr: `${testIp}/32`, expiresAt: null, reason: 'test' }))
        .set(IP_RULES_VERSION_KEY, `test-${Date.now()}`)
        .exec();
      const denyList = new IpDenyList(new RedisIpRuleSource(redis));
      await denyList.refresh();
      const res = await request(gateway(denyList)).get('/api/v1/transactions/x').set('X-Forwarded-For', testIp);
      expect([res.status, res.body.error.code]).toEqual([403, 'IP_BLOCKED']);
    } finally {
      const restore = redis.multi().del(IP_RULES_KEY);
      if (Object.keys(previous.rules).length) restore.hset(IP_RULES_KEY, previous.rules);
      if (previous.version) restore.set(IP_RULES_VERSION_KEY, previous.version);
      else restore.del(IP_RULES_VERSION_KEY);
      await restore.exec();
    }
  });
});
