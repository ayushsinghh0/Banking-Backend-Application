/**
 * Graceful shutdown over real HTTP: refuse new streams, send `reconnect` to every open stream and close it,
 * so the server stops promptly (keep-alive 61 s notwithstanding); then stop Kafka, unsubscribe and close Redis.
 */
import { shutdownSteps } from '../src/app';
import { HttpRig, startHttpRig, tokenFor } from './support/http-app';
import { openSse } from './support/sse-client';
import { aUser, rig as unitRig } from './support/harness';
import { settle } from './support/fake-redis';

describe('graceful shutdown', () => {
  let rig: HttpRig;

  beforeEach(async () => {
    rig = await startHttpRig();
  });
  afterEach(async () => {
    if (rig.server.listening) await rig.stop();
  });

  it('every open stream gets `reconnect` and ends; the server then closes at once; Kafka, the subscriber and Redis close in order', async () => {
    const clients = [await openSse(`${rig.url}/api/v1/realtime/stream`, { authorization: `Bearer ${tokenFor('cust-1')}` })];
    clients.push(await openSse(`${rig.url}/api/v1/realtime/stream`, { authorization: `Bearer ${tokenFor('admin-1', 'BANK_ADMIN')}` }));
    await Promise.all(clients.map((c) => c.waitFor((f) => f.event === 'ready')));
    expect(rig.subscriber.channels.size).toBe(3);

    const order: string[] = [];
    const kafka = { disconnect: jest.fn(async () => void order.push('kafka')) };
    const hubClose = rig.hub.close.bind(rig.hub);
    const hub = { close: jest.fn(async () => { order.push('hub'); await hubClose(); }) };
    const redis = [{ quit: jest.fn(async () => void order.push('cache-redis')) }, { quit: jest.fn(async () => void order.push('security-redis')) }];
    const steps = shutdownSteps({ streams: rig.app.streams, hub, kafka, redis });

    // What SIGTERM does: our drain runs first, then startHttpServer closes the server and runs the cleanup
    const started = Date.now();
    steps.drain();
    const closed = new Promise<void>((resolve) => rig.server.close(() => resolve()));

    for (const client of clients) {
      const frame = await client.waitFor((f) => f.event === 'reconnect');
      expect(frame.data).toBe('{"reason":"shutdown"}');
      await client.waitForEnd();
    }
    await closed;
    expect(Date.now() - started).toBeLessThan(2_000);
    await settle();
    expect(rig.redis.zsets.get('rt:streams:user:cust-1')!.size).toBe(0);
    expect(rig.redis.zsets.get('rt:streams:user:admin-1')!.size).toBe(0);
    expect(rig.subscriber.channels.size).toBe(0); // the streams' channels were released as they closed

    for (const step of steps.cleanup) await step();
    expect(order).toEqual(['kafka', 'hub', 'cache-redis', 'security-redis']);
    expect(rig.subscriber.status).toBe('end');
  });

  it('while draining, new streams are refused with 503 and Retry-After, and /health reports DOWN', async () => {
    rig.app.streams.drain();
    const res = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${tokenFor('cust-1')}` } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect((await res.json()).error.code).toBe('SERVER_BUSY');
    expect((await fetch(`${rig.url}/health`)).status).toBe(503);
  });

  it('drain is idempotent (SIGTERM and SIGINT may both arrive)', async () => {
    const drain = jest.fn(() => 0);
    const steps = shutdownSteps({ streams: { drain }, hub: { close: jest.fn() }, kafka: null, redis: [] });
    steps.drain();
    steps.drain();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe('drain (unit)', () => {
  it('ends every session with `reconnect {reason: shutdown}` and stops the registry heartbeat', async () => {
    const r = unitRig();
    r.manager.start();
    const a = await r.connect(aUser({ id: 'u1' }));
    const b = await r.connect(aUser({ id: 'u2' }));
    expect(r.manager.drain()).toBe(2);
    for (const { stream, res } of [a, b]) {
      expect(stream!.sent.at(-1)).toEqual({ event: 'reconnect', data: { reason: 'shutdown' }, id: undefined });
      expect(stream!.closed).toBe(true);
      await settle();
      expect(res.socket.end).toHaveBeenCalled(); // the connection itself is ended once the response is flushed
    }
    expect(r.manager.size).toBe(0);
  });
});
