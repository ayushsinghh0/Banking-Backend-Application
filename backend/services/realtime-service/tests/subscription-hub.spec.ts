/**
 * One subscriber connection per replica, channels reference counted by the local streams that need them.
 */
import { SubscriptionHub } from '../src/redis/subscription-hub';
import { FakeRedisClient, FakeRedisServer, settle } from './support/fake-redis';

describe('SubscriptionHub', () => {
  let server: FakeRedisServer;
  let subscriber: FakeRedisClient;
  let hub: SubscriptionHub;
  let calls: string[];

  const envelope = (id: string) => JSON.stringify({ id, type: 'account.status', at: '2026-10-28T10:00:00.000Z', data: { accountId: 'a', status: 'FROZEN' } });

  beforeEach(() => {
    server = new FakeRedisServer();
    subscriber = server.client();
    calls = [];
    const subscribe = subscriber.subscribe.bind(subscriber);
    const unsubscribe = subscriber.unsubscribe.bind(subscriber);
    subscriber.subscribe = (...channels: string[]) => {
      calls.push(`SUBSCRIBE ${channels.join(' ')}`);
      return subscribe(...channels);
    };
    subscriber.unsubscribe = (...channels: string[]) => {
      calls.push(`UNSUBSCRIBE ${channels.join(' ')}`);
      return unsubscribe(...channels);
    };
    hub = new SubscriptionHub(subscriber);
  });

  it('REF COUNTING: the first listener subscribes, others share it, the last one to leave unsubscribes', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await hub.add('rt:user:alice', a);
    await hub.add('rt:user:alice', b);
    expect(calls).toEqual(['SUBSCRIBE rt:user:alice']);
    expect(hub.listenerCount('rt:user:alice')).toBe(2);

    hub.remove('rt:user:alice', a);
    expect(calls).toEqual(['SUBSCRIBE rt:user:alice']);
    hub.remove('rt:user:alice', b);
    hub.remove('rt:user:alice', b); // a second remove is a no-op
    await settle();
    expect(calls).toEqual(['SUBSCRIBE rt:user:alice', 'UNSUBSCRIBE rt:user:alice']);
    expect(hub.channelCount).toBe(0);
    expect(subscriber.channels.size).toBe(0);
  });

  it('each message is parsed once and handed to every local listener of that channel only', async () => {
    const alice1 = jest.fn();
    const alice2 = jest.fn();
    const bob = jest.fn();
    await hub.add('rt:user:alice', alice1);
    await hub.add('rt:user:alice', alice2);
    await hub.add('rt:user:bob', bob);
    server.publish('rt:user:alice', envelope('1-0'));
    await settle();
    expect(alice1).toHaveBeenCalledWith(expect.objectContaining({ id: '1-0', type: 'account.status' }), 'rt:user:alice');
    expect(alice2).toHaveBeenCalledTimes(1);
    expect(alice1.mock.calls[0][0]).toBe(alice2.mock.calls[0][0]);
    expect(bob).not.toHaveBeenCalled();
  });

  it('a second stream joining while the SUBSCRIBE is in flight waits for Redis to confirm it', async () => {
    const order: string[] = [];
    const first = hub.add('rt:user:alice', jest.fn()).then(() => order.push('first'));
    const second = hub.add('rt:user:alice', jest.fn()).then(() => order.push('second'));
    expect(order).toEqual([]);
    await Promise.all([first, second]);
    expect(order.sort()).toEqual(['first', 'second']);
    expect(calls).toEqual(['SUBSCRIBE rt:user:alice']);
  });

  it('a refused SUBSCRIBE fails every waiting stream and is forgotten, so the next stream tries again', async () => {
    server.failNext('subscribe', new Error('Connection is closed.'));
    const results = await Promise.allSettled([hub.add('rt:user:alice', jest.fn()), hub.add('rt:user:alice', jest.fn())]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(hub.channelCount).toBe(0);
    await hub.add('rt:user:alice', jest.fn());
    expect(calls).toEqual(['SUBSCRIBE rt:user:alice', 'SUBSCRIBE rt:user:alice']);
    expect(hub.listenerCount('rt:user:alice')).toBe(1);
  });

  it('unsubscribe-then-subscribe races end subscribed (commands on one connection stay in order)', async () => {
    const a = jest.fn();
    await hub.add('rt:user:alice', a);
    hub.remove('rt:user:alice', a);
    const b = jest.fn();
    await hub.add('rt:user:alice', b);
    server.publish('rt:user:alice', envelope('2-0'));
    await settle();
    expect(b).toHaveBeenCalledTimes(1);
    expect(subscriber.channels.has('rt:user:alice')).toBe(true);
  });

  it('drops unreadable messages and keeps serving', async () => {
    const listener = jest.fn();
    await hub.add('rt:role:BANK_ADMIN', listener);
    server.publish('rt:role:BANK_ADMIN', '{not json');
    server.publish('rt:role:BANK_ADMIN', JSON.stringify({ id: 'x', type: 'bad\nevent', at: 'now', data: {} }));
    server.publish('rt:role:BANK_ADMIN', envelope('r-1'));
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws does not stop the others', async () => {
    const good = jest.fn();
    await hub.add('rt:user:alice', () => {
      throw new Error('boom');
    });
    await hub.add('rt:user:alice', good);
    server.publish('rt:user:alice', envelope('3-0'));
    await settle();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('RECONNECT: after the subscriber connection comes back, listeners are told (live events were lost meanwhile)', async () => {
    const reconnected = jest.fn();
    hub.onReconnect(reconnected);
    await hub.add('rt:user:alice', jest.fn());
    subscriber.recover(); // the initial 'ready' is not a reconnect
    await settle();
    expect(reconnected).not.toHaveBeenCalled();

    subscriber.drop();
    expect(hub.healthy).toBe(false);
    subscriber.recover();
    expect(reconnected).not.toHaveBeenCalled(); // deferred until ioredis has re-sent its subscriptions
    await settle();
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(hub.healthy).toBe(true);
  });

  it('an UNSUBSCRIBE that failed while disconnected is retried when the connection is back', async () => {
    const a = jest.fn();
    await hub.add('rt:user:alice', a);
    subscriber.drop();
    hub.remove('rt:user:alice', a);
    await settle();
    expect(subscriber.channels.has('rt:user:alice')).toBe(true); // ioredis would re-subscribe it on reconnect
    subscriber.recover();
    await settle();
    expect(subscriber.channels.has('rt:user:alice')).toBe(false);
  });

  it('close() unsubscribes everything, quits, and refuses new listeners', async () => {
    await hub.add('rt:user:alice', jest.fn());
    await hub.add('rt:role:SUPPORT', jest.fn());
    await hub.close();
    expect(calls).toContain('UNSUBSCRIBE rt:user:alice rt:role:SUPPORT');
    expect(subscriber.status).toBe('end');
    await expect(hub.add('rt:user:bob', jest.fn())).rejects.toThrow(/closed/);
  });
});
