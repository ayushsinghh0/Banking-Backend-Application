import crypto from 'crypto';
import express from 'express';
import Redis from 'ioredis';
import request from 'supertest';
import { createGcraMiddleware, errorHandlerMiddleware, GcraLimiter, parseRate } from '../src';

describe('parseRate', () => {
  it('reads the limit formats used in configuration', () => {
    expect(parseRate('600/min')).toEqual({ limit: 600, periodMs: 60_000 });
    expect(parseRate('20/s')).toEqual({ limit: 20, periodMs: 1_000 });
    expect(parseRate(' 300 / hour ')).toEqual({ limit: 300, periodMs: 3_600_000 });
    expect(() => parseRate('0/min')).toThrow();
    expect(() => parseRate('lots')).toThrow();
  });
});

// The algorithm is a Lua script, so it is tested against a real Redis: set REDIS_TEST_URL (any scratch
// instance; keys use a random prefix and expire by themselves). Skipped otherwise.
const url = process.env.REDIS_TEST_URL;
const describeRedis = url ? describe : describe.skip;

describeRedis('GCRA against Redis', () => {
  let redis: Redis;
  const prefix = `test:gcra:${crypto.randomBytes(4).toString('hex')}:`;
  beforeAll(() => {
    redis = new Redis(url!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('allows the burst at once, then refuses with the exact wait for the next slot', async () => {
    const limiter = new GcraLimiter(redis, prefix);
    const rule = { name: 'burst', limit: 60, periodMs: 60_000, burst: 3 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.check(rule, 'client-1'));

    expect(results.slice(0, 3).map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining).slice(0, 3)).toEqual([2, 1, 0]);
    expect(results[3]).toMatchObject({ allowed: false, banned: false });
    expect(results[3].retryAfterMs).toBeGreaterThan(900);
    expect(results[3].retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  it('keeps clients apart and refills at the sustained rate', async () => {
    const limiter = new GcraLimiter(redis, prefix);
    const rule = { name: 'refill', limit: 20, periodMs: 1_000, burst: 1 };
    expect((await limiter.check(rule, 'a')).allowed).toBe(true);
    expect((await limiter.check(rule, 'a')).allowed).toBe(false);
    expect((await limiter.check(rule, 'b')).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect((await limiter.check(rule, 'a')).allowed).toBe(true);
  });

  it('reports a request that costs more than the whole burst as never allowed', async () => {
    const limiter = new GcraLimiter(redis, prefix);
    const result = await limiter.check({ name: 'cost', limit: 10, periodMs: 1_000, burst: 2 }, 'c', { cost: 3 });
    expect(result).toMatchObject({ allowed: false, retryAfterMs: -1 });
  });

  it('checks the ban key first, in the same round trip', async () => {
    const limiter = new GcraLimiter(redis, prefix);
    const banKey = `${prefix}ban:203.0.113.9`;
    await redis.set(banKey, 'credential-stuffing', 'PX', 5_000);
    const result = await limiter.check({ name: 'ip', limit: 10, periodMs: 1_000, burst: 5 }, '203.0.113.9', { banKey });
    expect(result.banned).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(4_000);
  });

  it('as middleware: sets headers, answers 429 with Retry-After, and 403 for banned clients', async () => {
    const app = express();
    app.use(
      createGcraMiddleware(redis, {
        rule: { name: 'mw', limit: 60, periodMs: 60_000, burst: 1 },
        key: (req) => req.header('x-client') ?? null,
        banKey: (req) => `${prefix}ban:${req.header('x-client')}`,
        keyPrefix: prefix,
      })
    );
    app.get('/', (_req, res) => res.json({ ok: true }));
    app.use(errorHandlerMiddleware);

    const ok = await request(app).get('/').set('x-client', 'm1').expect(200);
    expect(ok.headers['x-ratelimit-limit']).toBe('1');
    const limited = await request(app).get('/').set('x-client', 'm1').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await request(app).get('/').expect(200); // no key: this limit doesn't apply

    await redis.set(`${prefix}ban:m2`, '1', 'PX', 5_000);
    const banned = await request(app).get('/').set('x-client', 'm2').expect(403);
    expect(banned.body.error.code).toBe('IP_BLOCKED');
  });
});

describe('GCRA middleware without Redis', () => {
  it('fails open by default and closed when asked', async () => {
    const broken = { defineCommand: () => undefined, banksphereGcra: () => Promise.reject(new Error('Connection is closed.')) };
    const build = (failOpen: boolean) => {
      const app = express();
      app.use(
        createGcraMiddleware(broken as unknown as Redis, {
          rule: { name: 'x', limit: 1, periodMs: 1_000, burst: 1 },
          key: () => 'k',
          failOpen,
        })
      );
      app.get('/', (_req, res) => res.json({ ok: true }));
      app.use(errorHandlerMiddleware);
      return app;
    };
    await request(build(true)).get('/').expect(200);
    await request(build(false)).get('/').expect(503);
  });
});
