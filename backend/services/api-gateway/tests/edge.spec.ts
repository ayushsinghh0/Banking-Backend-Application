import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { generateJwtKeyPair, metricsRegistry, signAccessToken } from '@banksphere/common';
import { createGateway, defaultRoutes, GatewayOptions } from '../src/app';
import { canonicalPath, isStreamingRequest, routeClassOf } from '../src/classify';
import { edgeLimitsFromEnv, runtimeConfigFromEnv } from '../src/config';
import { IpDenyList, IpRuleSource, parseRuleCidr } from '../src/ip-rules';
import { FakeGcra } from './support/fake-gcra';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'edge-kid';
process.env.JWT_VERIFY_KEYS = `edge-kid:${keys.publicKeyB64}`;

const tokenFor = (userId: string) =>
  signAccessToken({ sub: userId, email: `${userId}@example.com`, role: 'CUSTOMER', tokenVersion: 0, mfa: false, sessionId: `s-${userId}` });

const metricValue = async (name: string, labels: Record<string, string>): Promise<number> => {
  const metric = (await metricsRegistry.getMetricsAsJSON()).find((m) => m.name === name);
  const match = (metric?.values ?? []).find((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value));
  return Number(match?.value ?? 0);
};

describe('request classification', () => {
  it('canonicalises paths the way upstream routers read them, and refuses undecodable or dot-segment paths', () => {
    expect(canonicalPath('/API/v1//Transactions/%74ransfer/')).toBe('/api/v1/transactions/transfer');
    expect(canonicalPath('/api/v1/transactions/%E0%A4%A')).toBeNull();
    expect(canonicalPath('/api/v1/payments/webhooks/../top-ups')).toBeNull();
    expect(canonicalPath('/api/v1/payments/webhooks/%2e%2e/top-ups')).toBeNull();
    expect(canonicalPath('/api/v1/./auth')).toBeNull();
    expect(canonicalPath('/api/v1/auth/admin/ip-bans/203.0.113.7')).toBe('/api/v1/auth/admin/ip-bans/203.0.113.7');
  });

  it('puts money movements, assistant messages and webhooks in their cost classes (POST only, exact paths)', () => {
    const table: Array<[string, string, string | null]> = [
      ['POST', '/api/v1/transactions/transfer', 'money-write'],
      ['POST', '/api/v1/transactions/withdrawal-codes', 'money-write'],
      ['POST', '/api/v1/transactions/beneficiaries', 'money-write'],
      ['POST', '/api/v1/payments/top-ups', 'money-write'],
      ['GET', '/api/v1/transactions/beneficiaries', null],
      ['DELETE', '/api/v1/transactions/beneficiaries/b1', null],
      ['POST', '/api/v1/payments/top-ups/t1/confirm', null],
      ['POST', '/api/v1/assistant/conversations/c1/messages', 'assistant'],
      ['GET', '/api/v1/assistant/conversations/c1', null],
      ['POST', '/api/v1/payments/webhooks/razorpay', 'webhook'],
      ['GET', '/api/v1/payments/webhooks/razorpay', 'webhook'],
      ['POST', '/api/v1/payments/webhooks/razorpay/extra', null],
    ];
    for (const [method, path, expected] of table) expect([method, path, routeClassOf(method, path)]).toEqual([method, path, expected]);
  });

  it('knows the two streaming routes', () => {
    expect(isStreamingRequest('GET', '/api/v1/realtime/stream')).toBe(true);
    expect(isStreamingRequest('POST', '/api/v1/assistant/conversations/c1/messages')).toBe(true);
    expect(isStreamingRequest('POST', '/api/v1/realtime/stream')).toBe(false);
    expect(isStreamingRequest('GET', '/api/v1/assistant/conversations')).toBe(false);
  });

  it('routes the new services from their URLs', () => {
    const routes = defaultRoutes({ PAYMENT_SERVICE_URL: 'http://payment:8007', ASSISTANT_SERVICE_URL: 'http://assistant:8008', REALTIME_SERVICE_URL: 'http://realtime:8009' });
    expect(routes.filter((r) => ['payment-service', 'assistant-service', 'realtime-service'].includes(r.name))).toEqual([
      { name: 'payment-service', prefix: '/api/v1/payments', target: 'http://payment:8007' },
      { name: 'assistant-service', prefix: '/api/v1/assistant', target: 'http://assistant:8008' },
      { name: 'realtime-service', prefix: '/api/v1/realtime', target: 'http://realtime:8009' },
    ]);
  });
});

describe('edge configuration', () => {
  it('defaults to the limits in the design', () => {
    const limits = edgeLimitsFromEnv({});
    expect(limits).toEqual({
      ip: { name: 'ip', limit: 600, periodMs: 60_000, burst: 200 },
      user: { name: 'user', limit: 300, periodMs: 60_000, burst: 100 },
      moneyWrite: { name: 'money-write', limit: 30, periodMs: 60_000, burst: 10 },
      assistant: { name: 'assistant', limit: 20, periodMs: 60_000, burst: 5 },
      webhook: { name: 'webhook', limit: 600, periodMs: 60_000, burst: 100 },
    });
    expect(runtimeConfigFromEnv({})).toEqual({ maxInflight: 1024, maxStreams: 5000, upstreamTimeoutMs: 15_000, connectTimeoutMs: 5_000, ipRulesRefreshMs: 5_000 });
  });

  it('reads overrides, honours the old per-minute setting, and refuses malformed values', () => {
    const limits = edgeLimitsFromEnv({ GATEWAY_RATE_USER: '50/s', GATEWAY_BURST_USER: '7', GATEWAY_RATE_LIMIT_PER_MINUTE: '5000' });
    expect(limits.user).toEqual({ name: 'user', limit: 50, periodMs: 1_000, burst: 7 });
    expect(limits.ip.limit).toBe(5000);
    expect(edgeLimitsFromEnv({ GATEWAY_RATE_LIMIT_PER_MINUTE: '5000', GATEWAY_RATE_IP: '10/s' }).ip).toMatchObject({ limit: 10, periodMs: 1_000 });
    expect(() => edgeLimitsFromEnv({ GATEWAY_RATE_IP: 'lots' })).toThrow('GATEWAY_RATE_IP');
    expect(() => edgeLimitsFromEnv({ GATEWAY_BURST_MONEY_WRITE: '0' })).toThrow('GATEWAY_BURST_MONEY_WRITE');
    expect(() => edgeLimitsFromEnv({ GATEWAY_BURST_ASSISTANT: '2.5' })).toThrow('GATEWAY_BURST_ASSISTANT');
    expect(() => runtimeConfigFromEnv({ GATEWAY_MAX_INFLIGHT: '-1' })).toThrow('GATEWAY_MAX_INFLIGHT');
    expect(() => runtimeConfigFromEnv({ GATEWAY_MAX_STREAMS: 'many' })).toThrow('GATEWAY_MAX_STREAMS');
  });
});

describe('gateway edge protection', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  const seen: string[] = [];
  let release: Array<() => void> = [];

  beforeAll(async () => {
    const app = express();
    app.get('/api/v1/transactions/slow', (_req, res) => {
      release.push(() => res.json({ ok: true }));
    });
    app.get('/api/v1/realtime/stream', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      release.push(() => res.end());
    });
    app.all('*', (req, res) => {
      seen.push(`${req.method} ${req.originalUrl}`);
      res.json({ ok: true });
    });
    upstream = app.listen(0);
    await new Promise((r) => upstream.once('listening', r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(() => upstream.close());
  beforeEach(() => {
    seen.length = 0;
    release = [];
  });

  const routes = () => [
    { name: 'transaction-service', prefix: '/api/v1/transactions', target: upstreamUrl },
    { name: 'payment-service', prefix: '/api/v1/payments', target: upstreamUrl },
    { name: 'assistant-service', prefix: '/api/v1/assistant', target: upstreamUrl },
    { name: 'realtime-service', prefix: '/api/v1/realtime', target: upstreamUrl },
  ];
  const small = (name: string, burst: number) => ({ name, limit: 60, periodMs: 60_000, burst });
  const limits = { ip: small('ip', 5), user: small('user', 3), moneyWrite: small('money-write', 2), assistant: small('assistant', 1), webhook: small('webhook', 2) };
  const gateway = (overrides: GatewayOptions = {}) => createGateway({ routes: routes(), limits, trustProxy: 1, ipDenyList: null, ...overrides });

  describe('GCRA tiers', () => {
    it('limits every client address, with headers from the tier closest to refusing and Retry-After on refusal', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api/v1/transactions/accounts/a1/history').set('X-Forwarded-For', '198.51.100.7');
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-remaining']).toBe(String(4 - i));
      }
      const refused = await request(app).get('/api/v1/transactions/accounts/a1/history').set('X-Forwarded-For', '198.51.100.7');
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(seen).toHaveLength(5);
      // Another address has its own bucket; IPv6 clients are keyed by their /64
      expect((await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '198.51.100.8')).status).toBe(200);
      await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '2001:db8:1:2:aaaa::1');
      expect(gcra.keysFor('ip').at(-1)).toBe('2001:db8:1:2::/64');
      expect(gcra.calls.at(-1)!.banKey).toBe('edge:ban:2001:db8:1:2::/64');
    });

    it('limits signed-in users per user across addresses; invalid or missing tokens are keyed by address only', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      const token = tokenFor('u-1');
      for (let i = 0; i < 3; i++) {
        expect((await request(app).get('/api/v1/transactions/x').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', `198.51.100.${i + 10}`)).status).toBe(200);
      }
      const refused = await request(app).get('/api/v1/transactions/x').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '198.51.100.99');
      expect(refused.status).toBe(429);
      expect(gcra.keysFor('user')).toEqual(['u-1', 'u-1', 'u-1', 'u-1']);

      // A forged token (valid shape, wrong signature) never selects a user bucket: it is limited by address
      const forged = `${token.slice(0, token.lastIndexOf('.'))}.${'A'.repeat(86)}`;
      for (const header of [`Bearer ${forged}`, 'Bearer not-a-jwt', undefined]) {
        const req = request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '198.51.100.50');
        if (header) req.set('Authorization', header);
        expect((await req).status).toBe(200);
      }
      expect(gcra.keysFor('user')).toHaveLength(4);
      // The token was still forwarded untouched: the service authenticates it, not the gateway
      expect(seen.length).toBeGreaterThan(0);
    });

    it('adds the money-write class on POSTs that move money, keyed by user, whatever the spelling of the path', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra, limits: { ...limits, ip: small('ip', 100), user: small('user', 100) } });
      const auth = { Authorization: `Bearer ${tokenFor('u-2')}` };
      expect((await request(app).post('/api/v1/transactions/transfer').set(auth).send({})).status).toBe(200);
      // Upstream routers are case-insensitive and tolerate extra slashes: this is the same transfer route
      expect((await request(app).post('/api/v1/transactions//TRANSFER/').set(auth).send({})).status).toBe(200);
      const refused = await request(app).post('/api/v1/payments/top-ups').set(auth).send({});
      expect(refused.status).toBe(429);
      expect(gcra.keysFor('money-write')).toEqual(['user:u-2', 'user:u-2', 'user:u-2']);
      // Reads of the same resources are not money movements
      expect((await request(app).get('/api/v1/transactions/beneficiaries').set(auth)).status).toBe(200);
      expect(gcra.keysFor('money-write')).toHaveLength(3);
      // Without a valid token the class is keyed by address
      await request(app).post('/api/v1/transactions/withdrawal-codes').set('X-Forwarded-For', '198.51.100.20').send({});
      expect(gcra.keysFor('money-write').at(-1)).toBe('ip:198.51.100.20');
    });

    it('adds the assistant class on conversation messages', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      const auth = { Authorization: `Bearer ${tokenFor('u-3')}` };
      expect((await request(app).post('/api/v1/assistant/conversations/c1/messages').set(auth).send({ content: 'hi' })).status).toBe(200);
      expect((await request(app).post('/api/v1/assistant/conversations/c2/messages').set(auth).send({ content: 'hi' })).status).toBe(429);
      expect((await request(app).get('/api/v1/assistant/conversations').set(auth)).status).toBe(200);
      expect(gcra.keysFor('assistant')).toEqual(['user:u-3', 'user:u-3']);
    });

    it('limits payment webhooks per address in their own tier, exempt from the general tiers (but not from bans)', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      // The general per-IP bucket is exhausted...
      for (let i = 0; i < 6; i++) await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '203.0.113.50');
      // ...webhooks from the same address still go through, under the webhook tier only
      const hook = () => request(app).post('/api/v1/payments/webhooks/razorpay').set('X-Forwarded-For', '203.0.113.50').send({ event: 'payment.captured' });
      expect((await hook()).status).toBe(200);
      expect((await hook()).status).toBe(200);
      expect((await hook()).status).toBe(429);
      expect(gcra.keysFor('webhook')).toEqual(['203.0.113.50', '203.0.113.50', '203.0.113.50']);
      expect(gcra.calls.filter((c) => c.rule === 'webhook').every((c) => c.banKey === 'edge:ban:203.0.113.50')).toBe(true);
      expect(gcra.keysFor('ip')).toHaveLength(6);

      gcra.bans.set('edge:ban:203.0.113.51', gcra.now + 60_000);
      const banned = await request(app).post('/api/v1/payments/webhooks/razorpay').set('X-Forwarded-For', '203.0.113.51').send({});
      expect([banned.status, banned.body.error.code]).toEqual([403, 'IP_BLOCKED']);
    });

    it('BAN: a banned address gets 403 IP_BLOCKED with the remaining ban as Retry-After, before any other tier', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      const before = await metricValue('gateway_ip_blocked_total', { reason: 'ban' });
      gcra.bans.set('edge:ban:203.0.113.9', gcra.now + 1_800_000);
      const res = await request(app).post('/api/v1/transactions/transfer').set('X-Forwarded-For', '203.0.113.9').set('Authorization', `Bearer ${tokenFor('u-4')}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IP_BLOCKED');
      expect(res.headers['retry-after']).toBe('1800');
      expect(gcra.calls.map((c) => c.rule)).toEqual(['ip']);
      expect(seen).toHaveLength(0);
      expect(await metricValue('gateway_ip_blocked_total', { reason: 'ban' })).toBe(before + 1);
      // The ban ends with its TTL
      gcra.now += 1_800_001;
      expect((await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '203.0.113.9')).status).toBe(200);
    });

    it('fails open when the edge Redis is unavailable (one failed call, not one per tier)', async () => {
      const gcra = new FakeGcra();
      gcra.fail = true;
      const res = await request(gateway({ limiter: gcra })).post('/api/v1/transactions/transfer').set('Authorization', `Bearer ${tokenFor('u-5')}`).send({});
      expect(res.status).toBe(200);
      expect(gcra.calls).toHaveLength(1);
    });

    it('never limits health checks', async () => {
      const gcra = new FakeGcra();
      const app = gateway({ limiter: gcra });
      for (let i = 0; i < 10; i++) expect((await request(app).get('/health/live')).status).toBe(200);
      expect(gcra.calls).toHaveLength(0);
    });
  });

  describe('IP deny rules', () => {
    class FakeSource implements IpRuleSource {
      version: string | null = null;
      rules: Record<string, string> = {};
      reads = 0;
      error: Error | null = null;
      async readVersion() {
        if (this.error) throw this.error;
        return this.version;
      }
      async readRules() {
        this.reads += 1;
        return { ...this.rules };
      }
    }
    const rule = (cidr: string, expiresAt: string | null = null, reason = 'abuse') => JSON.stringify({ cidr, expiresAt, reason });

    it('parses CIDRs and bare addresses, and rejects malformed ones', () => {
      expect(parseRuleCidr('203.0.113.0/24')).toEqual({ address: '203.0.113.0', prefix: 24, family: 'ipv4' });
      expect(parseRuleCidr('2001:db8::/32')).toEqual({ address: '2001:db8::', prefix: 32, family: 'ipv6' });
      expect(parseRuleCidr('198.51.100.4')).toEqual({ address: '198.51.100.4', prefix: 32, family: 'ipv4' });
      for (const bad of ['203.0.113.0/33', '2001:db8::/129', 'not-an-ip/8', '1.2.3.4/8/9', '10.0.0.0/ 8', 42, null]) expect(parseRuleCidr(bad)).toBeNull();
    });

    it('blocks addresses inside a rule with 403 IP_BLOCKED, counted by reason', async () => {
      const source = new FakeSource();
      source.version = 'v1';
      source.rules = { r1: rule('203.0.113.0/24'), r2: rule('2001:db8:bad::/48') };
      const denyList = new IpDenyList(source);
      await denyList.refresh();
      const app = gateway({ ipDenyList: denyList });
      const before = await metricValue('gateway_ip_blocked_total', { reason: 'rule' });

      for (const ip of ['203.0.113.77', '2001:db8:bad:1::5']) {
        const res = await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', ip);
        expect([ip, res.status, res.body.error?.code]).toEqual([ip, 403, 'IP_BLOCKED']);
      }
      expect((await request(app).get('/api/v1/transactions/x').set('X-Forwarded-For', '203.0.114.1')).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(await metricValue('gateway_ip_blocked_total', { reason: 'rule' })).toBe(before + 2);
      // Health checks come from the load balancer and are never blocked
      expect((await request(app).get('/health/live').set('X-Forwarded-For', '203.0.113.77')).status).toBe(200);
    });

    it('reloads only when the version changes, skips expired and malformed entries without failing', async () => {
      const source = new FakeSource();
      let now = Date.parse('2026-10-28T10:00:00Z');
      source.version = 'v1';
      source.rules = {
        good: rule('198.51.100.0/24'),
        expired: rule('192.0.2.0/24', '2026-10-28T09:00:00Z'),
        notJson: '{oops',
        badCidr: rule('300.1.1.1/8'),
        badExpiry: JSON.stringify({ cidr: '192.0.2.0/24', expiresAt: 'tomorrow' }),
      };
      const denyList = new IpDenyList(source, { now: () => now });
      await denyList.refresh();
      expect(denyList.size).toBe(1);
      expect(denyList.isBlocked('198.51.100.3')).toBe(true);
      expect(denyList.isBlocked('::ffff:198.51.100.3')).toBe(true);
      expect(denyList.isBlocked('192.0.2.1')).toBe(false);

      await denyList.refresh();
      await denyList.refresh();
      expect(source.reads).toBe(1); // same version: one GET each, no HGETALL

      source.version = 'v2';
      source.rules = { other: rule('192.0.2.0/24', '2026-10-28T10:05:00Z') };
      await denyList.refresh();
      expect(source.reads).toBe(2);
      expect(denyList.isBlocked('198.51.100.3')).toBe(false);
      expect(denyList.isBlocked('192.0.2.1')).toBe(true);

      // A rule stops applying when it expires, without waiting for a new version
      now = Date.parse('2026-10-28T10:05:00Z');
      await denyList.refresh();
      expect(denyList.isBlocked('192.0.2.1')).toBe(false);
      expect(source.reads).toBe(2);
    });

    it('keeps the loaded rules when the version key is gone (evicted) or Redis fails', async () => {
      const source = new FakeSource();
      source.version = 'v1';
      source.rules = { r1: rule('203.0.113.0/24') };
      const denyList = new IpDenyList(source);
      await denyList.refresh();
      source.version = null;
      source.rules = {};
      await denyList.refresh();
      expect(denyList.isBlocked('203.0.113.1')).toBe(true);
      source.error = new Error('connection lost');
      await expect(denyList.refresh()).rejects.toThrow('connection lost');
      expect(denyList.isBlocked('203.0.113.1')).toBe(true);
      expect(denyList.loadedVersion).toBe('v1');
    });

    it('polls in the background and stops cleanly', async () => {
      const source = new FakeSource();
      source.version = 'v1';
      source.rules = { r1: rule('203.0.113.0/24') };
      const denyList = new IpDenyList(source);
      const stop = denyList.start(10);
      await new Promise((r) => setTimeout(r, 30));
      expect(denyList.isBlocked('203.0.113.1')).toBe(true);
      source.version = 'v2';
      source.rules = {};
      await new Promise((r) => setTimeout(r, 40));
      expect(denyList.isBlocked('203.0.113.1')).toBe(false);
      stop();
      source.version = 'v3';
      source.rules = { r1: rule('203.0.113.0/24') };
      await new Promise((r) => setTimeout(r, 40));
      expect(denyList.loadedVersion).toBe('v2');
    });
  });

  describe('load shedding', () => {
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(condition()).toBe(true);
    };

    it('answers 503 SERVER_BUSY with Retry-After: 1 past GATEWAY_MAX_INFLIGHT; health checks are exempt', async () => {
      const app = gateway({ runtime: { maxInflight: 2, maxStreams: 10 } });
      const server = app.listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const slow = [fetch(`${base}/api/v1/transactions/slow`), fetch(`${base}/api/v1/transactions/slow`)];
        await waitFor(() => release.length === 2);
        const before = await metricValue('gateway_shed_total', { reason: 'inflight' });
        const busy = await fetch(`${base}/api/v1/transactions/x`);
        expect(busy.status).toBe(503);
        expect(busy.headers.get('retry-after')).toBe('1');
        expect((await busy.json()).error.code).toBe('SERVER_BUSY');
        expect(await metricValue('gateway_shed_total', { reason: 'inflight' })).toBe(before + 1);
        expect((await fetch(`${base}/health/live`)).status).toBe(200);

        release.forEach((r) => r());
        await Promise.all(slow);
        await waitFor(() => app.locals.shedder.counts.inflight === 0);
        expect((await fetch(`${base}/api/v1/transactions/x`)).status).toBe(200);
      } finally {
        server.close();
      }
    });

    it('counts streams separately (they never use the request cap) and caps them with GATEWAY_MAX_STREAMS', async () => {
      const app = gateway({ runtime: { maxInflight: 1, maxStreams: 1 } });
      const server = app.listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const controller = new AbortController();
      try {
        const stream = await fetch(`${base}/api/v1/realtime/stream`, { signal: controller.signal });
        expect(stream.status).toBe(200);
        expect(app.locals.shedder.counts).toEqual({ inflight: 0, streams: 1 });
        // An ordinary request still fits under the request cap
        expect((await fetch(`${base}/api/v1/transactions/x`)).status).toBe(200);
        const second = await fetch(`${base}/api/v1/realtime/stream`);
        expect(second.status).toBe(503);
        expect((await second.json()).error.code).toBe('SERVER_BUSY');

        controller.abort();
        await waitFor(() => app.locals.shedder.counts.streams === 0);
      } finally {
        release.forEach((r) => r());
        server.closeAllConnections?.();
        server.close();
      }
    });
  });

  it('STAFF NETWORK: payment administration is a staff path; customer payment routes and webhooks are not', async () => {
    process.env.STAFF_ALLOWED_CIDRS = '10.20.0.0/16';
    try {
      const app = gateway();
      for (const path of ['/api/v1/payments/admin/top-ups', '/api/v1/Payments/Admin/summary', '/api/v1/payments/admin']) {
        const res = await request(app).get(path).set('X-Forwarded-For', '203.0.113.5');
        expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'NETWORK_NOT_ALLOWED']);
      }
      expect((await request(app).get('/api/v1/payments/admin/summary').set('X-Forwarded-For', '10.20.3.4')).status).toBe(200);
      for (const path of ['/api/v1/payments/top-ups', '/api/v1/payments/config']) {
        expect((await request(app).get(path).set('X-Forwarded-For', '203.0.113.5')).status).toBe(200);
      }
      expect((await request(app).post('/api/v1/payments/webhooks/razorpay').set('X-Forwarded-For', '203.0.113.5').send({})).status).toBe(200);
    } finally {
      delete process.env.STAFF_ALLOWED_CIDRS;
    }
  });

  it('refuses dot-segment paths before they reach any upstream', async () => {
    const res = await request(gateway()).post('/api/v1/payments/webhooks/%2e%2e/top-ups').send({});
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('serves no /metrics on the public port (Prometheus scrapes METRICS_PORT) and never proxies it to a service', async () => {
    const app = gateway();
    for (const path of ['/metrics', '/metrics/', '/METRICS', '/api/metrics']) {
      const res = await request(app).get(path);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 404, 'NOT_FOUND']);
    }
    expect(seen).toHaveLength(0);
  });

  it("the gateway's own routes are health checks only (everything else is proxied to a service that authorizes it)", () => {
    const app = gateway();
    const own = (app._router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route!.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`));
    expect(own.sort()).toEqual(['GET /health', 'GET /health/live']);
  });
});
