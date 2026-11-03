/**
 * The Lua scripts against a REAL Redis (7.x). Runs only when REALTIME_TEST_REDIS_URL points at a disposable
 * Redis, e.g.  docker run --rm -p 127.0.0.1:6399:6379 redis:7.4-alpine  and
 * REALTIME_TEST_REDIS_URL=redis://127.0.0.1:6399. Every other test uses the in-memory double, whose mirrors of
 * these scripts this suite keeps honest.
 */
import crypto from 'crypto';
import Redis from 'ioredis';
import { RealtimeStore, withRealtimeScripts } from '../src/redis/realtime-store';
import { SubscriptionHub } from '../src/redis/subscription-hub';
import { RealtimeEnvelope, RealtimeEventBody } from '../src/events/types';

const url = process.env.REALTIME_TEST_REDIS_URL;
const suite = url ? describe : describe.skip;

const event = (n: number): RealtimeEventBody => ({ type: 'account.status', at: '2026-10-28T10:00:00.000Z', data: { accountId: `acc-${n}`, status: 'FROZEN' } });

suite('Lua scripts on a real Redis', () => {
  let redis: Redis;
  let subscriber: Redis;
  let store: RealtimeStore;
  let hub: SubscriptionHub;
  const user = `it-${crypto.randomUUID()}`;

  beforeAll(async () => {
    redis = new Redis(url!, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    subscriber = new Redis(url!, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await Promise.all([redis.connect(), subscriber.connect()]);
    store = new RealtimeStore(withRealtimeScripts(redis));
    hub = new SubscriptionHub(subscriber);
  });

  afterAll(async () => {
    await redis.del(`rt:log:user:${user}`, `rt:streams:user:${user}`);
    await hub.close();
    await redis.quit();
  });

  it('deliver: XADD + EXPIRE + PUBLISH atomically, the published message carrying the id XADD assigned', async () => {
    const received: RealtimeEnvelope[] = [];
    await hub.add(`rt:user:${user}`, (e) => received.push(e));
    const first = await store.deliverToUser(user, event(1), 'evt-1');
    expect(first.duplicate).toBe(false);
    expect(first.id).toMatch(/^\d+-\d+$/);
    for (let i = 0; i < 50 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([{ id: first.id, ...event(1) }]);
    const ttl = await redis.ttl(`rt:log:user:${user}`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('deliver: a redelivery (same dedupe key) is recognised and NOT logged or published again', async () => {
    const received: RealtimeEnvelope[] = [];
    const listener = (e: RealtimeEnvelope) => received.push(e);
    await hub.add(`rt:user:${user}`, listener);
    const again = await store.deliverToUser(user, event(1), 'evt-1');
    expect(again.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
    expect(await redis.xlen(`rt:log:user:${user}`)).toBe(1);
    hub.remove(`rt:user:${user}`, listener);
  });

  it('the log is capped near 100 entries and readSince returns the newest after an exclusive start, oldest first', async () => {
    const ids: string[] = [];
    for (let n = 2; n <= 260; n++) ids.push((await store.deliverToUser(user, event(n), `evt-${n}`)).id);
    const length = await redis.xlen(`rt:log:user:${user}`);
    expect(length).toBeGreaterThanOrEqual(100);
    expect(length).toBeLessThan(260); // MAXLEN ~ trims whole nodes: approximately 100

    const since = await store.readSince(user, ids[ids.length - 4], 100);
    expect(since.map((e) => e.data.accountId)).toEqual(['acc-258', 'acc-259', 'acc-260']);
    const capped = await store.readSince(user, '0-0', 100);
    expect(capped).toHaveLength(100);
    expect(capped[99].data.accountId).toBe('acc-260');
  });

  it('admit: at most `limit` live entries; stale ones are pruned; the key expires', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(await store.admit({ userId: user, connectionId: `c${i}` }, { limit: 5, staleAfterMs: 60_000 }, now)).toBe(true);
    }
    expect(await store.admit({ userId: user, connectionId: 'c5' }, { limit: 5, staleAfterMs: 60_000 }, now)).toBe(false);
    expect(await redis.ttl(`rt:streams:user:${user}`)).toBeGreaterThan(100);
    // Later, only c0 was refreshed: the other four are stale and stop counting
    await store.refresh([{ userId: user, connectionId: 'c0' }], 60_000, now + 61_000);
    expect(await store.admit({ userId: user, connectionId: 'c6' }, { limit: 5, staleAfterMs: 60_000 }, now + 61_001)).toBe(true);
    expect(await redis.zcard(`rt:streams:user:${user}`)).toBe(2);
    await store.release({ userId: user, connectionId: 'c6' });
    expect(await redis.zcard(`rt:streams:user:${user}`)).toBe(1);
  });
});
