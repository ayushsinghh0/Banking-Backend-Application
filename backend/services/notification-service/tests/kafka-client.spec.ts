/**
 * KafkaService (packages/common/src/kafka/kafka-client.ts) against an in-memory KafkaJS double: per-consumer
 * retry topics, untrusted retry envelopes, dead-letter routing, heartbeats and SMTP error classification.
 */
const mockConsumers: any[] = [];
const mockSent: Array<{ topic: string; key: string; value: any }> = [];

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    ...actual,
    Kafka: jest.fn().mockImplementation(() => ({
      consumer: ({ groupId }: { groupId: string }) => {
        const consumer: any = {
          groupId,
          topics: [] as string[],
          events: { CRASH: 'crash', GROUP_JOIN: 'join', FETCH: 'fetch', HEARTBEAT: 'heartbeat' },
          on: jest.fn(),
          connect: jest.fn().mockResolvedValue(undefined),
          subscribe: jest.fn(async ({ topic }: { topic: string }) => consumer.topics.push(topic)),
          run: jest.fn(async ({ eachMessage }: any) => {
            consumer.eachMessage = eachMessage;
          }),
          commitOffsets: jest.fn().mockResolvedValue(undefined),
          seek: jest.fn(),
          pause: jest.fn(),
          resume: jest.fn(),
          disconnect: jest.fn().mockResolvedValue(undefined),
        };
        mockConsumers.push(consumer);
        return consumer;
      },
      producer: () => ({
        events: { DISCONNECT: 'disconnect' },
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        send: jest.fn(async ({ topic, messages }: any) => {
          for (const m of messages) mockSent.push({ topic, key: m.key, value: JSON.parse(m.value) });
        }),
      }),
    })),
  };
});

import { KafkaService, TransientError, isTransientError } from '@banksphere/common';

const flush = () => new Promise((r) => setImmediate(r));
const smtpError = (code: string | undefined, responseCode?: number, command?: string, message = 'smtp failure') =>
  Object.assign(new Error(message), { code, responseCode, command });

describe('KafkaService consumer pipeline', () => {
  const DELAYS = [60_000, 300_000];
  let kafka: KafkaService;

  async function subscribe(handler: (topic: string, payload: any) => Promise<void>, transientBudgetMs = 0) {
    kafka.subscribe('notification-service-group', ['transaction.completed.v1', 'account.created.v1'], handler, {
      retryNamespace: 'notification',
      transientBudgetMs,
      retryDelaysMs: DELAYS,
      maxAttempts: 1,
    });
    await flush();
    await flush();
    const main = mockConsumers.find((c) => c.groupId === 'notification-service-group');
    const retry = mockConsumers.find((c) => c.groupId === 'notification-service-group.retry');
    return { main, retry };
  }

  const message = (value: unknown, extra: Record<string, unknown> = {}) => ({
    offset: '7',
    key: Buffer.from('k-1'),
    value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    timestamp: Date.now().toString(),
    headers: {},
    ...extra,
  });

  const deliver = (consumer: any, topic: string, msg: any, heartbeat = jest.fn().mockResolvedValue(undefined)) =>
    consumer.eachMessage({ topic, partition: 0, message: msg, heartbeat, pause: jest.fn() });

  beforeEach(() => {
    mockConsumers.length = 0;
    mockSent.length = 0;
    kafka = new KafkaService({ clientId: 'test', brokers: ['localhost:9092'] });
  });

  afterEach(async () => {
    await kafka.disconnect();
  });

  it('ISOLATION: each consumer group has its own retry topics (<namespace>.<topic>.retry)', async () => {
    const { main, retry } = await subscribe(jest.fn());
    expect(main.topics).toEqual(['transaction.completed.v1', 'account.created.v1']);
    expect(retry.topics).toEqual(['notification.transaction.completed.v1.retry', 'notification.account.created.v1.retry']);
  });

  it('refuses to subscribe without a valid retry namespace', () => {
    expect(() => kafka.subscribe('g', ['t.v1'], jest.fn(), { retryNamespace: '' } as any)).toThrow(/retry namespace/i);
    expect(() => kafka.subscribe('g', ['t.v1'], jest.fn(), { retryNamespace: 'a.b' } as any)).toThrow(/retry namespace/i);
  });

  it('a transient failure is parked on the consumer-specific retry topic, with the email address redacted', async () => {
    const { main } = await subscribe(async () => {
      throw new TransientError('550 <alice@bank.com> mailbox busy');
    });
    await deliver(main, 'transaction.completed.v1', message({ eventId: 'e-1' }));
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].topic).toBe('notification.transaction.completed.v1.retry');
    expect(mockSent[0].value).toEqual(expect.objectContaining({ __retry: 1, hop: 1, payload: { eventId: 'e-1' } }));
    expect(mockSent[0].value.lastError).not.toContain('alice@');
    expect(main.commitOffsets).toHaveBeenCalled();
  });

  it('RETRY: the original topic comes from the retry topic name, never from the envelope', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const { retry } = await subscribe(handler);
    await deliver(
      retry,
      'notification.transaction.completed.v1.retry',
      message({ __retry: 1, hop: 1, retryAt: Date.now() - 1, lastError: 'x', payload: { eventId: 'e-2' } })
    );
    expect(handler).toHaveBeenCalledWith('transaction.completed.v1', { eventId: 'e-2' }, undefined);
    expect(retry.commitOffsets).toHaveBeenCalled();
  });

  it('RETRY: an envelope naming another topic is garbage and goes to the ORIGINAL topic dlq', async () => {
    const handler = jest.fn();
    const { retry } = await subscribe(handler);
    await deliver(
      retry,
      'notification.transaction.completed.v1.retry',
      message({ __retry: 1, originalTopic: 'account.created.v1', hop: 1, retryAt: 0, lastError: 'x', payload: { eventId: 'e-3' } })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(mockSent.map((s) => s.topic)).toEqual(['transaction.completed.v1.dlq']);
    expect(retry.commitOffsets).toHaveBeenCalled();
  });

  it.each([
    ['non-JSON', 'not json at all'],
    ['not an envelope', { eventId: 'e-4' }],
    ['hop of the wrong type', { __retry: 1, hop: '1', retryAt: 0, payload: {} }],
    ['hop beyond the configured hops', { __retry: 1, hop: 99, retryAt: 0, payload: {} }],
    ['retryAt of the wrong type', { __retry: 1, hop: 1, retryAt: 'soon', payload: {} }],
    ['missing payload', { __retry: 1, hop: 1, retryAt: 0 }],
  ])('RETRY: garbage (%s) goes to the original topic dlq, never to a "<x>.retry.dlq"', async (_label, value) => {
    const handler = jest.fn();
    const { retry } = await subscribe(handler);
    await deliver(retry, 'notification.transaction.completed.v1.retry', message(value));
    expect(handler).not.toHaveBeenCalled();
    expect(mockSent.map((s) => s.topic)).toEqual(['transaction.completed.v1.dlq']);
    expect(retry.commitOffsets).toHaveBeenCalled();
  });

  it('RETRY: a far-future retryAt is clamped to parked time + the longest delay (cannot stall a partition)', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const { retry } = await subscribe(handler);
    const parkedLongAgo = (Date.now() - DELAYS[1] - 1_000).toString();
    const forged = { __retry: 1, hop: 1, retryAt: Date.now() + 10 * 365 * 86400_000, lastError: 'x', payload: { eventId: 'e-5' } };
    await deliver(retry, 'notification.transaction.completed.v1.retry', message(forged, { timestamp: parkedLongAgo }));
    expect(handler).toHaveBeenCalledWith('transaction.completed.v1', { eventId: 'e-5' }, undefined);
  });

  it('RETRY: a message that is not due yet pauses its partition and is not handled', async () => {
    const handler = jest.fn();
    const { retry } = await subscribe(handler);
    await deliver(
      retry,
      'notification.transaction.completed.v1.retry',
      message({ __retry: 1, hop: 1, retryAt: Date.now() + 30_000, lastError: 'x', payload: { eventId: 'e-6' } })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(retry.pause).toHaveBeenCalled();
    expect(retry.commitOffsets).not.toHaveBeenCalled();
  });

  it('a message whose retry hops are exhausted is dead-lettered on the original topic dlq (redacted)', async () => {
    const { retry } = await subscribe(async () => {
      throw new TransientError('still down for bob@bank.com');
    });
    await deliver(
      retry,
      'notification.account.created.v1.retry',
      message({ __retry: 1, hop: DELAYS.length, retryAt: 0, lastError: 'x', payload: { eventId: 'e-7' } })
    );
    expect(mockSent.map((s) => s.topic)).toEqual(['account.created.v1.dlq']);
    expect(mockSent[0].value.failureReason).not.toContain('bob@');
  });

  it('HEARTBEAT: keeps heartbeating while a slow handler runs', async () => {
    const { main } = await subscribe(() => new Promise((resolve) => setTimeout(resolve, 10_000)));
    // Only timers are faked: faking microtasks/setImmediate strands the consumer's promises and keeps Jest alive
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'Date', 'hrtime', 'performance'] });
    try {
      const heartbeat = jest.fn().mockResolvedValue(undefined);
      const done = deliver(main, 'transaction.completed.v1', message({ eventId: 'e-8' }), heartbeat);
      await jest.advanceTimersByTimeAsync(10_000);
      await done;
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('isTransientError: SMTP classification', () => {
  it.each(['EDNS', 'ETLS', 'EPROTOCOL', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT'])('%s (infrastructure) is transient', (code) => {
    expect(isTransientError(smtpError(code))).toBe(true);
  });

  it('EAUTH is transient even with a 5xx response (credential rotation is an infrastructure problem)', () => {
    expect(isTransientError(smtpError('EAUTH', 535, 'AUTH PLAIN'))).toBe(true);
  });

  it('a 5xx on a command other than RCPT/DATA (e.g. MAIL FROM = our own sender) is transient', () => {
    expect(isTransientError(smtpError(undefined, 550, 'MAIL FROM'))).toBe(true);
    expect(isTransientError(smtpError('EENVELOPE', 550, 'MAIL FROM'))).toBe(true);
    expect(isTransientError(smtpError(undefined, 554, 'CONN'))).toBe(true);
  });

  it('a message too large for the server is permanent', () => {
    expect(isTransientError(smtpError('EMESSAGE', undefined, 'MAIL FROM', 'Message size larger than allowed 1000'))).toBe(false);
  });

  it('per-message rejections are permanent', () => {
    expect(isTransientError(smtpError('EENVELOPE', 550, 'RCPT TO'))).toBe(false);
    expect(isTransientError(smtpError('EMESSAGE', 554, 'DATA'))).toBe(false);
    expect(isTransientError(smtpError(undefined, 550, 'RCPT TO'))).toBe(false);
    expect(isTransientError(smtpError(undefined, 552, 'DATA'))).toBe(false);
  });

  it('4xx (try again later) is transient, also on RCPT/DATA', () => {
    expect(isTransientError(smtpError('EENVELOPE', 452, 'RCPT TO'))).toBe(true);
    expect(isTransientError(smtpError('EMESSAGE', 451, 'DATA'))).toBe(true);
  });
});
