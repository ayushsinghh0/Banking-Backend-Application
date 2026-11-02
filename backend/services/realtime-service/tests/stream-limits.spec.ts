/**
 * At most 5 streams per user across ALL replicas (a Redis sorted set scored by heartbeat), and a per-replica
 * cap on open streams.
 */
import { aUser, rig } from './support/harness';
import { FakeRedisServer, settle } from './support/fake-redis';

describe('stream limits', () => {
  it('PER USER, ACROSS REPLICAS: the 6th concurrent stream gets 429 TOO_MANY_STREAMS with Retry-After', async () => {
    const server = new FakeRedisServer();
    const replicaA = rig({ server });
    const replicaB = rig({ server });
    for (let i = 0; i < 3; i++) expect((await replicaA.connect()).stream).toBeDefined();
    for (let i = 0; i < 2; i++) expect((await replicaB.connect()).stream).toBeDefined();

    const sixth = await replicaB.connect();
    expect(sixth.stream).toBeUndefined();
    expect(sixth.error).toMatchObject({ statusCode: 429, errorCode: 'TOO_MANY_STREAMS' });
    expect(sixth.res.headers['retry-after']).toBe('20');
    // ...and the refused stream left nothing behind
    expect(server.zsets.get('rt:streams:user:cust-1')!.size).toBe(5);
    expect(replicaB.hub.listenerCount('rt:user:cust-1')).toBe(2);

    // Other users are not affected
    expect((await replicaB.connect(aUser({ id: 'cust-2' }))).stream).toBeDefined();
  });

  it('closing a stream frees its slot', async () => {
    const r = rig();
    const open = [];
    for (let i = 0; i < 5; i++) open.push(await r.connect());
    expect((await r.connect()).error?.statusCode).toBe(429);
    open[0].res.disconnect();
    await settle();
    expect((await r.connect()).stream).toBeDefined();
  });

  it('entries of a replica that died without cleaning up stop counting once their heartbeat is stale', async () => {
    const server = new FakeRedisServer();
    let now = 1_790_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const crashed = rig({ server });
      for (let i = 0; i < 5; i++) await crashed.connect();
      // The crashed replica never refreshes or removes its entries
      now += 61_000;
      const survivor = rig({ server });
      expect((await survivor.connect()).stream).toBeDefined();
      expect(server.zsets.get('rt:streams:user:cust-1')!.size).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('a live replica keeps its streams counted by refreshing their heartbeat (one pipeline for all of them)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const server = new FakeRedisServer();
      const r = rig({ server });
      r.manager.start();
      await r.connect();
      await r.connect(aUser({ id: 'cust-2' }));
      const scoreBefore = [...server.zsets.get('rt:streams:user:cust-1')!.values()][0];
      jest.advanceTimersByTime(20_000);
      await settle();
      expect(server.commands.filter((c) => c === 'exec')).toHaveLength(1);
      expect([...server.zsets.get('rt:streams:user:cust-1')!.values()][0]).toBeGreaterThan(scoreBefore);
      expect(server.ttls.get('rt:streams:user:cust-2')).toBe(120);
    } finally {
      jest.useRealTimers();
    }
  });

  it('PER REPLICA: beyond REALTIME_MAX_CONNECTIONS new streams get 503 SERVER_BUSY (streams being set up count too)', async () => {
    const r = rig({ settings: { maxConnections: 2 } });
    await r.connect(aUser({ id: 'u1' }));
    await r.connect(aUser({ id: 'u2' }));
    const third = await r.connect(aUser({ id: 'u3' }));
    expect(third.error).toMatchObject({ statusCode: 503, errorCode: 'SERVER_BUSY' });
    expect(third.res.headers['retry-after']).toBe('5');
    expect(r.server.zsets.get('rt:streams:user:u3')).toBeUndefined(); // refused before touching Redis
  });

  it('Redis unavailable while admitting or subscribing: 503 (retryable), and nothing is left registered', async () => {
    const r = rig();
    r.server.failNext('rtAdmit', new Error('Connection is closed.'));
    expect((await r.connect()).error).toMatchObject({ statusCode: 503, errorCode: 'SERVICE_UNAVAILABLE' });

    r.server.failNext('subscribe', new Error('Connection is closed.'));
    const failed = await r.connect();
    expect(failed.error).toMatchObject({ statusCode: 503 });
    await settle();
    expect(r.server.zsets.get('rt:streams:user:cust-1')!.size).toBe(0);
    expect(r.hub.channelCount).toBe(0);
    expect(r.manager.size).toBe(0);
  });
});
