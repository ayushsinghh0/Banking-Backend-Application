/**
 * The Kafka consumer: what each delivery writes to Redis, malformed and stale events, redeliveries, and how
 * Redis failures are classified for the shared retry / dead-letter pipeline.
 */
import { TransientError, isTransientError, metricsRegistry } from '@banksphere/common';
import { KafkaRealtimeConsumer, REALTIME_RETRY_DELAYS_MS } from '../src/consumers/realtime.consumer';
import { RealtimeStore } from '../src/redis/realtime-store';
import { FakeRedisServer, settle } from './support/fake-redis';

const NOW = Date.parse('2026-10-28T10:00:00.000Z');

describe('KafkaRealtimeConsumer', () => {
  let server: FakeRedisServer;
  let consumer: KafkaRealtimeConsumer;
  let received: Array<{ channel: string; message: any }>;

  const transfer = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'evt-1',
    eventType: 'transaction.completed.v1',
    timestamp: new Date(NOW - 1_000).toISOString(),
    transactionId: 'tx-1',
    referenceId: 'TXN-1',
    type: 'TRANSFER',
    amountInPaise: '250000',
    sourceAccountId: 'acc-a',
    destinationAccountId: 'acc-b',
    sourceCustomerId: 'alice',
    destinationCustomerId: 'bob',
    ...overrides,
  });

  async function metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    const values = (await metricsRegistry.getSingleMetric(name)?.get())?.values ?? [];
    return values.filter((v) => Object.entries(labels).every(([k, l]) => (v.labels as any)[k] === l)).reduce((sum, v) => sum + v.value, 0);
  }

  beforeEach(() => {
    server = new FakeRedisServer();
    server.now = () => NOW;
    consumer = new KafkaRealtimeConsumer({ subscribe: jest.fn() }, new RealtimeStore(server.client()), { groupId: 'realtime-service-group', maxEventAgeMs: 3_600_000, now: () => NOW });
    // A listener on every channel this test cares about
    received = [];
    const listener = server.client();
    for (const channel of ['rt:user:alice', 'rt:user:bob', 'rt:role:BANK_ADMIN', 'rt:role:FRAUD_ANALYST', 'rt:role:SUPPORT', 'rt:role:CUSTOMER', 'rt:role:TELLER']) {
      listener.channels.add(channel);
    }
    listener.on('message', (channel: string, message: string) => received.push({ channel, message: JSON.parse(message) }));
  });

  it('subscribes as realtime-service-group to the five topics, with its own retry namespace and short retry hops', () => {
    const kafka = { subscribe: jest.fn() };
    new KafkaRealtimeConsumer(kafka, new RealtimeStore(server.client()), { groupId: 'realtime-service-group', maxEventAgeMs: 1 }).start();
    const [groupId, topics, , options] = kafka.subscribe.mock.calls[0];
    expect(groupId).toBe('realtime-service-group');
    expect(topics).toEqual(['transaction.completed.v1', 'payment.updated.v1', 'fraud.alert.created.v1', 'account.status.changed.v1', 'beneficiary.added.v1']);
    expect(options).toEqual({ retryNamespace: 'realtime', retryDelaysMs: REALTIME_RETRY_DELAYS_MS });
  });

  it('a transfer is logged for replay and published live to both parties, the published id matching the log id', async () => {
    await consumer.handle('transaction.completed.v1', transfer());
    await settle();
    const aliceLog = server.streams.get('rt:log:user:alice')!;
    const bobLog = server.streams.get('rt:log:user:bob')!;
    expect(aliceLog).toHaveLength(1);
    expect(bobLog).toHaveLength(1);
    expect(server.ttls.get('rt:log:user:alice')).toBe(86_400);
    expect(received.map((r) => [r.channel, r.message.data.direction])).toEqual([
      ['rt:user:alice', 'DEBIT'],
      ['rt:user:bob', 'CREDIT'],
    ]);
    expect(received[0].message).toEqual({
      id: aliceLog[0][0],
      type: 'transaction.posted',
      at: new Date(NOW - 1_000).toISOString(),
      data: { transactionId: 'tx-1', type: 'TRANSFER', amountInPaise: '250000', accountId: 'acc-a', direction: 'DEBIT' },
    });
  });

  it('role events are published only (no replay log) to every staff role the table names', async () => {
    await consumer.handle('fraud.alert.created.v1', { eventId: 'evt-f', timestamp: new Date(NOW).toISOString(), alertId: 'al-1', accountId: 'acc-a', severity: 'HIGH', reason: 'secret rule' });
    await settle();
    expect([...server.streams.keys()]).toEqual([]);
    expect(received.map((r) => r.channel)).toEqual(['rt:role:FRAUD_ANALYST', 'rt:role:BANK_ADMIN', 'rt:role:SUPPORT']);
    expect(received[0].message).toEqual({ id: 'r-evt-f', type: 'fraud.alert', at: new Date(NOW).toISOString(), data: { alertId: 'al-1', severity: 'HIGH', accountId: 'acc-a' } });
  });

  it('payment.updated: the customer first (replayable), then the BANK_ADMIN queue', async () => {
    await consumer.handle('payment.updated.v1', { eventId: 'evt-p', timestamp: new Date(NOW).toISOString(), topUpId: 'tu-1', customerId: 'alice', accountId: 'acc-a', amountInPaise: '50000', status: 'CREDITED', previousStatus: 'CAPTURED' });
    await settle();
    expect(received.map((r) => r.channel)).toEqual(['rt:user:alice', 'rt:role:BANK_ADMIN']);
    expect(server.streams.get('rt:log:user:alice')).toHaveLength(1);
  });

  it('a REDELIVERED message (or a retry after a partial failure) reaches nobody twice', async () => {
    await consumer.handle('transaction.completed.v1', transfer());
    // Bob's side (the second delivery) failed the first time round...
    server.failNext('rtDeliver', Object.assign(new Error('Connection is closed.'), {}), 1);
    await expect(consumer.handle('transaction.completed.v1', transfer({ eventId: 'evt-2' }))).rejects.toBeInstanceOf(TransientError);
    // ...and the retry delivers it without repeating Alice's
    await consumer.handle('transaction.completed.v1', transfer({ eventId: 'evt-2' }));
    await consumer.handle('transaction.completed.v1', transfer());
    await settle();
    expect(server.streams.get('rt:log:user:alice')).toHaveLength(2);
    expect(server.streams.get('rt:log:user:bob')).toHaveLength(2);
    expect(received.filter((r) => r.channel === 'rt:user:alice')).toHaveLength(2);
  });

  it('MALFORMED events are logged and skipped: no throw, nothing written', async () => {
    const before = await metric('realtime_kafka_events_skipped_total', { reason: 'malformed' });
    await expect(consumer.handle('transaction.completed.v1', { eventId: 'evt-x', transactionId: 'tx', type: 'TRANSFER', amountInPaise: 'lots' })).resolves.toBeUndefined();
    await expect(consumer.handle('account.status.changed.v1', null)).resolves.toBeUndefined();
    await settle();
    expect(server.commands).toEqual([]);
    expect(received).toEqual([]);
    expect(await metric('realtime_kafka_events_skipped_total', { reason: 'malformed' })).toBe(before + 2);
  });

  it('STALE events (older than the live window) are not pushed', async () => {
    await consumer.handle('transaction.completed.v1', transfer({ timestamp: new Date(NOW - 2 * 3_600_000).toISOString() }));
    expect(server.commands).toEqual([]);
  });

  it.each([
    ['connection closed', Object.assign(new Error('Connection is closed.'), {})],
    ['offline queue disabled', new Error("Stream isn't writeable and enableOfflineQueue options is false")],
    ['max retries', Object.assign(new Error('Reached the max retries per request limit'), { name: 'MaxRetriesPerRequestError' })],
    ['refused connection', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
  ])('Redis unavailable (%s) is a TransientError: retried, never dead-lettered', async (_label, error) => {
    server.failNext('rtDeliver', error);
    const err = await consumer.handle('account.status.changed.v1', { eventId: 'e', accountId: 'a', customerId: 'alice', status: 'FROZEN' }).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(isTransientError(err)).toBe(true);
  });

  it('a Redis REFUSAL (e.g. ACL NOPERM) is not transient: a few attempts, then the dead-letter topic', async () => {
    server.failNext('publish', Object.assign(new Error("NOPERM this user has no permissions to access the 'rt:role:SUPPORT' channel"), { name: 'ReplyError' }));
    const err = await consumer.handle('fraud.alert.created.v1', { eventId: 'e', alertId: 'al', accountId: 'a', severity: 'LOW' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isTransientError(err)).toBe(false);
  });

  it('counts published events per type', async () => {
    const before = await metric('realtime_events_published_total', { type: 'transaction.posted' });
    await consumer.handle('transaction.completed.v1', transfer({ eventId: 'evt-m' }));
    expect(await metric('realtime_events_published_total', { type: 'transaction.posted' })).toBe(before + 2);
  });
});
