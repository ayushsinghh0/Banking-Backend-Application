import { Kafka, Producer, Consumer, EachMessagePayload, logLevel, Partitioners, LogEntry } from 'kafkajs';
import { logger } from '../logger/logger';

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
}

export interface SubscribeOptions {
  /** Attempts for a message that keeps failing with a NON-transient error before it is dead-lettered */
  maxAttempts?: number;
}

/**
 * Throw this (or any error isTransientError recognises) from a handler to say "the message is fine,
 * a dependency is temporarily unavailable": the message is retried until it succeeds, never dead-lettered.
 */
export class TransientError extends Error {
  public readonly transient = true;
}

const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ESOCKET', 'ECONNECTION', 'ETIMEOUT',
]);

/**
 * Infrastructure failures (database/Redis/SMTP unavailable, pool exhausted, lock/deadlock, SMTP 4xx)
 * say nothing about the message itself and must be retried rather than dead-lettered.
 */
export function isTransientError(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  if (e.transient === true) return true;
  if (TRANSIENT_PRISMA_CODES.has(e.code) || TRANSIENT_NET_CODES.has(e.code)) return true;
  if (e.name === 'PrismaClientInitializationError' || e.name === 'PrismaClientRustPanicError') return true;
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) return true; // SMTP 4xx
  return /Connection is closed|Stream isn't writeable|connect ECONNREFUSED|lock timeout|deadlock detected|could not serialize/i.test(
    String(e.message ?? '')
  );
}

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private producerConnecting: Promise<Producer> | null = null;
  private consumers: Consumer[] = [];
  private readonly consumerState = new Map<string, 'starting' | 'running' | 'crashed' | 'stopped'>();
  /** Last time each consumer completed a fetch from the broker (empty fetches included) */
  private readonly lastFetch = new Map<string, number>();
  private stopping = false;

  constructor(config?: KafkaConfig) {
    const clientId = config?.clientId || process.env.KAFKA_CLIENT_ID || 'banksphere-service';
    const brokers = config?.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']);
    const username = process.env.KAFKA_USERNAME;
    const password = process.env.KAFKA_PASSWORD;

    this.kafka = new Kafka({
      clientId,
      brokers,
      ...(username && password
        ? { sasl: { mechanism: 'scram-sha-512' as const, username, password }, ssl: process.env.KAFKA_SSL === 'true' }
        : {}),
      logLevel: logLevel.WARN,
      logCreator:
        () =>
        ({ level, label, log }: LogEntry) => {
          const { message, ...extra } = log;
          const fields = { kafka: true, ...extra };
          // Broker-side "coordinator loading / not available" errors are retried by KafkaJS and are
          // normal while Kafka starts; surface them as warnings rather than errors
          if (level === logLevel.ERROR && !/not available|is loading/i.test(String(extra.error ?? ''))) {
            logger.error(fields, `[kafkajs] ${message}`);
          } else {
            logger.warn(fields, `[kafkajs ${label}] ${message}`);
          }
        },
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
    });
  }

  public async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    // Single in-flight connect, so concurrent first publishes don't create several producers
    if (!this.producerConnecting) {
      this.producerConnecting = (async () => {
        const producer = this.kafka.producer({
          idempotent: true, // Broker-side deduplication of retried sends & in-order delivery
          maxInFlightRequests: 1,
          createPartitioner: Partitioners.DefaultPartitioner,
        });
        await producer.connect();
        producer.on(producer.events.DISCONNECT, () => {
          if (this.producer === producer) this.producer = null;
        });
        logger.info('Kafka idempotent producer connected');
        this.producer = producer;
        return producer;
      })().finally(() => {
        this.producerConnecting = null;
      });
    }
    return this.producerConnecting;
  }

  public async publishEvent(topic: string, key: string, payload: unknown): Promise<void> {
    const producer = await this.getProducer();
    await producer.send({
      topic,
      acks: -1, // Wait for all in-sync replicas
      messages: [
        {
          key,
          value: JSON.stringify(payload),
          timestamp: Date.now().toString(),
        },
      ],
    });
  }

  /**
   * True when every consumer of this process is running AND has talked to the broker recently
   * (used by /health). A consumer silently stuck reconnecting therefore shows up as unhealthy.
   */
  public consumersHealthy(maxSilenceMs = 60_000): boolean {
    for (const [groupId, state] of this.consumerState) {
      if (state !== 'running') return false;
      if (Date.now() - (this.lastFetch.get(groupId) ?? 0) > maxSilenceMs) return false;
    }
    return true;
  }

  /**
   * Subscribes with manual offset commits and keeps the consumer alive: if it cannot connect or
   * crashes with a non-retriable error, it is restarted with backoff (never silently left dead).
   *
   * Per message:
   * - success                    -> commit
   * - transient failure          -> retry with backoff until it succeeds (heartbeating meanwhile)
   * - persistent/poison failure  -> `maxAttempts` tries, then `<topic>.dlq` and commit
   */
  public subscribe(
    groupId: string,
    topics: string[],
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions = {}
  ): void {
    this.consumerState.set(groupId, 'starting');
    let attempt = 0;
    const startOnce = async (): Promise<void> => {
      try {
        await this.runConsumer(groupId, topics, messageHandler, options);
        attempt = 0;
      } catch (err) {
        if (this.stopping) return;
        attempt++;
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        this.consumerState.set(groupId, 'crashed');
        logger.error({ err, groupId, retryInMs: delay }, 'Kafka consumer failed to start, retrying');
        setTimeout(() => void startOnce(), delay).unref();
      }
    };
    void startOnce();
  }

  private async runConsumer(
    groupId: string,
    topics: string[],
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions
  ): Promise<void> {
    const maxAttempts = options.maxAttempts ?? 5;
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000 });

    consumer.on(consumer.events.CRASH, (event) => {
      if (this.stopping) return;
      // Not consuming until it rejoins the group (GROUP_JOIN flips it back), so /health reports it
      this.consumerState.set(groupId, 'crashed');
      if (event.payload.restart) {
        logger.warn({ groupId, err: event.payload.error }, 'Kafka consumer crashed; KafkaJS is restarting it');
        return;
      }
      // KafkaJS gave up: restart it ourselves
      this.consumerState.set(groupId, 'crashed');
      logger.error({ groupId, err: event.payload.error }, 'Kafka consumer crashed permanently; restarting');
      this.consumers = this.consumers.filter((c) => c !== consumer);
      consumer.disconnect().catch(() => {});
      setTimeout(() => {
        if (!this.stopping) this.subscribe(groupId, topics, messageHandler, options);
      }, 5_000).unref();
    });
    consumer.on(consumer.events.GROUP_JOIN, () => this.consumerState.set(groupId, 'running'));
    consumer.on(consumer.events.FETCH, () => this.lastFetch.set(groupId, Date.now()));

    await consumer.connect();
    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: true });
    }

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message, heartbeat }: EachMessagePayload) => {
        const commit = () =>
          consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
        const rawValue = message.value?.toString();
        if (!rawValue) {
          await commit();
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          logger.error({ topic, offset: message.offset }, 'Malformed JSON Kafka message routed to DLQ');
          await this.sendToDlq(topic, message.key?.toString(), rawValue, 'Malformed JSON');
          await commit();
          return;
        }

        const correlationId = parsed?.correlationId || message.headers?.['x-correlation-id']?.toString();

        let failures = 0;
        let transientRetries = 0;
        let lastError: unknown;
        for (;;) {
          if (this.stopping) throw new Error('Consumer stopping; message will be redelivered');
          try {
            await messageHandler(topic, parsed, correlationId);
            await commit();
            return;
          } catch (error) {
            lastError = error;
            const transient = isTransientError(error);
            if (transient) transientRetries++;
            else failures++;
            logger.warn(
              { err: error, topic, partition, offset: message.offset, transient, failures, transientRetries },
              'Consumer processing error'
            );
            if (!transient && failures >= maxAttempts) break;
            const delay = transient
              ? Math.min(500 * 2 ** Math.min(transientRetries, 6), 30_000)
              : Math.min(200 * 2 ** failures, 5_000);
            // Sleep in short slices and heartbeat, so a long outage doesn't trigger a rebalance
            for (let waited = 0; waited < delay; waited += 1_000) {
              await new Promise((r) => setTimeout(r, Math.min(1_000, delay - waited)));
              await heartbeat().catch(() => {});
            }
          }
        }

        await this.sendToDlq(topic, message.key?.toString(), rawValue, String((lastError as any)?.message ?? lastError));
        await commit();
      },
    });

    this.consumers.push(consumer);
    this.consumerState.set(groupId, 'running');
    this.lastFetch.set(groupId, Date.now());
    logger.info({ groupId, topics }, 'Kafka consumer subscribed and listening');
  }

  private async sendToDlq(topic: string, key: string | undefined, rawValue: string, reason: string): Promise<void> {
    // Throws if the DLQ itself is unreachable: the offset is then not committed and the message is redelivered
    await this.publishEvent(`${topic}.dlq`, key || 'unknown', {
      originalTopic: topic,
      failureReason: reason.slice(0, 1000),
      failedAt: new Date().toISOString(),
      rawValue,
    });
    logger.error({ topic, reason }, 'Message routed to dead-letter topic');
  }

  public async disconnect(): Promise<void> {
    this.stopping = true;
    for (const [groupId] of this.consumerState) this.consumerState.set(groupId, 'stopped');
    for (const consumer of this.consumers) {
      await consumer.disconnect().catch(() => {});
    }
    this.consumers = [];
    if (this.producer) {
      await this.producer.disconnect().catch(() => {});
      this.producer = null;
    }
  }
}
