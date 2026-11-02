/**
 * Catch-up after a reconnect (Last-Event-ID): subscribe first and buffer, then replay, then flush the buffer,
 * so nothing published around the reconnect is lost or shown twice, and ids only ever move forward.
 */
import { metricsRegistry } from '@banksphere/common';
import { RealtimeEventBody } from '../src/events/types';
import { compareStreamIds } from '../src/redis/envelope';
import { aUser, FakeResponse, rig, Rig } from './support/harness';
import { settle } from './support/fake-redis';

const statusEvent = (n: number): RealtimeEventBody => ({ type: 'account.status', at: '2026-10-28T10:00:00.000Z', data: { accountId: `acc-${n}`, status: 'FROZEN' } });

describe('stream catch-up and live delivery', () => {
  let r: Rig;
  let clock: number;

  beforeEach(() => {
    r = rig();
    clock = 1_790_000_000_000;
    // Every event gets its own millisecond, like a busy production stream
    r.server.now = () => ++clock;
  });

  const deliver = (n: number, userId = 'cust-1') => r.store.deliverToUser(userId, statusEvent(n), `evt-${n}`);
  const accounts = (stream: { events: Array<{ data: any }> }) => stream.events.map((e) => e.data.data.accountId);

  it('first event is `ready` with the connection id and heartbeat; then events go out live with their stream id', async () => {
    const { stream } = await r.connect();
    expect(stream!.sent[0]).toEqual({ event: 'ready', data: { connectionId: expect.any(String), heartbeatSeconds: 20 }, id: undefined });
    const { id } = await deliver(1);
    await settle();
    expect(stream!.sent[1]).toEqual({
      event: 'account.status',
      id,
      data: { id, type: 'account.status', at: '2026-10-28T10:00:00.000Z', data: { accountId: 'acc-1', status: 'FROZEN' } },
    });
  });

  it('REPLAY + LIVE: missed events, events published DURING the catch-up, and later ones each arrive exactly once, in order', async () => {
    const seen: string[] = [];
    for (let n = 1; n <= 5; n++) seen.push((await deliver(n)).id);
    // While the stream reads the log, two more events are published: they are in the log AND in the live buffer
    r.server.beforeRead = async () => {
      r.server.beforeRead = null;
      await deliver(6);
      await deliver(7);
      await settle(); // their live copies reach the subscriber before the log read completes
    };

    const { stream } = await r.connect(aUser(), { 'Last-Event-ID': seen[1] });
    await deliver(8);
    await settle();

    expect(stream!.sent[0].event).toBe('ready');
    expect(accounts(stream!)).toEqual(['acc-3', 'acc-4', 'acc-5', 'acc-6', 'acc-7', 'acc-8']);
    const sentIds = stream!.events.map((e) => e.id!);
    expect(new Set(sentIds).size).toBe(sentIds.length);
    for (let i = 1; i < sentIds.length; i++) expect(compareStreamIds(sentIds[i], sentIds[i - 1])).toBeGreaterThan(0);
  });

  it('counts replayed events', async () => {
    const replayed = async () => (await metricsRegistry.getSingleMetric('realtime_replayed_events_total')!.get()).values[0]?.value ?? 0;
    const before = await replayed();
    const first = await deliver(1);
    await deliver(2);
    await deliver(3);
    await r.connect(aUser(), { 'Last-Event-ID': first.id });
    expect(await replayed()).toBe(before + 2);
  });

  it('without Last-Event-ID there is no replay: only live events', async () => {
    await deliver(1);
    const { stream } = await r.connect();
    await deliver(2);
    await settle();
    expect(accounts(stream!)).toEqual(['acc-2']);
  });

  it.each(['garbage', '1-2-3', '', '../etc', '99999999999999999999-0'])('an unusable Last-Event-ID (%p) is ignored, not an error', async (value) => {
    await deliver(1);
    const { stream, error } = await r.connect(aUser(), { 'Last-Event-ID': value });
    expect(error).toBeUndefined();
    expect(accounts(stream!)).toEqual([]);
  });

  it('after a long absence, the NEWEST 100 missed events are replayed (no gap to the live ones)', async () => {
    const first = await deliver(0);
    for (let n = 1; n <= 120; n++) await deliver(n);
    const { stream } = await r.connect(aUser(), { 'Last-Event-ID': first.id });
    await deliver(121);
    await settle();
    const got = accounts(stream!);
    expect(got).toHaveLength(101);
    expect(got[0]).toBe('acc-21');
    expect(got[99]).toBe('acc-120');
    expect(got[100]).toBe('acc-121');
  });

  it('only the caller\'s own events: another user\'s log and channel are never read', async () => {
    await deliver(1, 'cust-2');
    const { stream } = await r.connect(aUser({ id: 'cust-1' }), { 'Last-Event-ID': '0-0' });
    await deliver(2, 'cust-2');
    await settle();
    expect(stream!.events).toEqual([]);
  });

  it('STAFF: live role events (no SSE id, so Last-Event-ID stays a user-log id) next to their own user events', async () => {
    const admin = aUser({ id: 'admin-1', role: 'BANK_ADMIN', mfa: true });
    const { stream } = await r.connect(admin);
    await r.store.publishToRole('BANK_ADMIN', { id: 'r-evt-9', type: 'payment.updated', at: '2026-10-28T10:00:00.000Z', data: { topUpId: 't', status: 'CREDITED', amountInPaise: '1', accountId: 'a' } });
    await r.store.publishToRole('SUPPORT', { id: 'r-evt-10', type: 'fraud.alert', at: '2026-10-28T10:00:00.000Z', data: { alertId: 'x', severity: 'LOW', accountId: 'a' } });
    await settle();
    expect(stream!.events).toEqual([{ event: 'payment.updated', id: undefined, data: expect.objectContaining({ id: 'r-evt-9' }) }]);
    expect(r.subscriber.channels).toEqual(new Set(['rt:user:admin-1', 'rt:role:BANK_ADMIN']));
  });

  it('customers are subscribed to their own channel only', async () => {
    await r.connect(aUser({ id: 'cust-9' }));
    expect(r.subscriber.channels).toEqual(new Set(['rt:user:cust-9']));
  });

  it('two tabs of the same user on one replica share ONE subscription; it ends with the last tab', async () => {
    const a = await r.connect();
    const b = await r.connect();
    expect(r.hub.listenerCount('rt:user:cust-1')).toBe(2);
    await deliver(1);
    await settle();
    expect(accounts(a.stream!)).toEqual(['acc-1']);
    expect(accounts(b.stream!)).toEqual(['acc-1']);

    a.res.disconnect();
    expect(r.hub.listenerCount('rt:user:cust-1')).toBe(1);
    b.res.disconnect();
    await settle();
    expect(r.subscriber.channels.size).toBe(0);
    expect(r.manager.size).toBe(0);
  });

  it('a client that leaves while its stream is being set up is cleaned up (no stream, subscription or registry entry)', async () => {
    const res = new FakeResponse();
    r.server.beforeRead = () => {
      r.server.beforeRead = null;
      res.disconnect();
    };
    const result = await r.connect(aUser(), { 'Last-Event-ID': '1-0' }, res);
    await settle();
    expect(result.stream).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(r.manager.size).toBe(0);
    expect(r.subscriber.channels.size).toBe(0);
    expect(r.server.zsets.get('rt:streams:user:cust-1')?.size ?? 0).toBe(0);
  });

  it('a subscriber outage ends every stream with `reconnect`, so clients catch up from the log', async () => {
    const { stream } = await r.connect();
    r.subscriber.drop();
    r.subscriber.recover();
    await settle();
    expect(stream!.sent.at(-1)).toEqual({ event: 'reconnect', data: { reason: 'resync' }, id: undefined });
    expect(stream!.closed).toBe(true);
    expect(r.manager.size).toBe(0);
  });

  it('a client that stops reading is cut off instead of buffering without bound', async () => {
    const { stream, res } = await r.connect();
    res.writableLength = 2_000_000;
    await deliver(1);
    await settle();
    expect(stream!.closed).toBe(true);
    expect(stream!.events).toEqual([]);
    expect(r.manager.size).toBe(0);
  });
});
