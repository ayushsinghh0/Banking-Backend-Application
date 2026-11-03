import { Kafka, Producer, Consumer, EachMessagePayload, logLevel, Partitioners, LogEntry } from 'kafkajs';
import { logger, redactEmails, redactErrorForLog } from '../logger/logger';
import { counter } from '../observability/metrics';

const consumed = counter('kafka_consumer_messages_total', 'Consumed Kafka messages by outcome', ['topic', 'result']);

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
}

export interface SubscribeOptions {
  /**
   * Namespace of this consumer's OWN delayed-retry topics, `<retryNamespace>.<topic>.retry` (e.g. "fraud"):
   * every consumer group parks messages on topics only its service may write and read (Kafka ACLs), so no
   * other service can inject or replay messages into its retry path.
   */
  retryNamespace: string;
  /** Attempts for a message that keeps failing with a NON-transient error before it is dead-lettered */
  maxAttempts?: number;
  /** How long a transient failure is retried in place before the message is parked on its retry topic (default 15s) */
  transientBudgetMs?: number;
  /** Delays (ms) for successive hops through the retry topic; after the last one the message is dead-lettered */
  retryDelaysMs?: number[];
  /** How often the consumer heartbeats while a handler is still running (default 3s) */
  heartbeatIntervalMs?: number;
}

/** Envelope for messages parked on a retry topic. Only `hop`, `retryAt` and `payload` are ever read back. */
interface RetryEnvelope {
  __retry: 1;
  /** Informational only: the original topic is always derived from the retry topic's name */
  originalTopic: string;
  hop: number;
  retryAt: number;
  lastError: string;
  payload: unknown;
}

/** Error text that is safe to log or store in Kafka (SMTP rejections quote the recipient's address) */
function errorText(err: unknown): string {
  return redactEmails(String((err as any)?.message ?? err));
}

const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000];
const RETRY_NAMESPACE = /^[a-z][a-z0-9-]{0,48}$/;

/** The delayed-retry topic a consumer namespace uses for `topic` */
export function retryTopicFor(namespace: string, topic: string): string {
  return `${namespace}.${topic}.retry`;
}

/**
 * Validates a message read back from a retry topic. The envelope is not trusted for routing: a message on
 * `<ns>.<topic>.retry` always belongs to `<topic>`, and an envelope that claims another topic is garbage.
 */
function parseRetryEnvelope(
  value: any,
  originalTopic: string,
  maxHops: number
): { hop: number; retryAt: number; payload: unknown } | null {
  if (!value || typeof value !== 'object' || value.__retry !== 1) return null;
  if (value.originalTopic !== undefined && value.originalTopic !== originalTopic) return null;
  if (!Number.isInteger(value.hop) || value.hop < 1 || value.hop > maxHops) return null;
  if (typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt)) return null;
  if (value.payload === undefined || value.payload === null) return null;
  return { hop: value.hop, retryAt: value.retryAt, payload: value.payload };
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
 * nodemailer codes for mail-infrastructure problems (DNS, TLS, connection, protocol, credentials, pool, config):
 * every message would fail the same way, so they are retried and never dead-lettered. EAUTH included: a
 * rotated SMTP password must not dead-letter every notification until someone notices.
 */
const SMTP_INFRASTRUCTURE_CODES = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EREQUIRETLS', 'EPROTOCOL', 'EAUTH', 'ENOAUTH', 'EOAUTH2',
  'EMAXLIMIT', 'ECONFIG', 'EPROXY',
]);
/** nodemailer codes for a rejection of this particular message (its recipients or content) */
const SMTP_MESSAGE_CODES = new Set(['EENVELOPE', 'EMESSAGE', 'EMAXRECIPIENTS']);
/** SMTP commands whose 5xx rejects this message rather than our mail setup */
const SMTP_PER_MESSAGE_COMMAND = /^(RCPT|DATA)\b/i;

/**
 * Infrastructure failures (database/Redis/SMTP unavailable, pool exhausted, lock/deadlock, SMTP 4xx, SMTP
 * DNS/TLS/protocol/authentication problems) say nothing about the message itself and must be retried rather
 * than dead-lettered. Only per-message SMTP rejections are permanent: EENVELOPE / EMESSAGE, or a 5xx reply to
 * RCPT TO / DATA. A 5xx anywhere else (greeting, EHLO, AUTH, MAIL FROM = our sender) breaks every message.
 */
export function isTransientError(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  if (e.transient === true) return true;
  if (TRANSIENT_PRISMA_CODES.has(e.code) || TRANSIENT_NET_CODES.has(e.code) || SMTP_INFRASTRUCTURE_CODES.has(e.code)) return true;
  if (e.name === 'PrismaClientInitializationError' || e.name === 'PrismaClientRustPanicError') return true;
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) return true; // SMTP 4xx: try later
  const command = String(e.command ?? '');
  if (SMTP_MESSAGE_CODES.has(e.code)) {
    // The server refusing OUR sender (MAIL FROM) is a configuration problem shared by every message
    return responseCode !== undefined && /^MAIL FROM\b/i.test(command);
  }
  if (responseCode !== undefined && responseCode >= 500) return !SMTP_PER_MESSAGE_COMMAND.test(command);
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
   * Subscribes with manual offset commits and keeps the consumers alive (restarted with backoff, never
   * silently left dead). Two consumer groups run per subscription:
   * - `groupId` on the main topics: a transient failure is retried in place only briefly; if the
   *   dependency stays down the message is parked on `<retryNamespace>.<topic>.retry` and the partition
   *   moves on. While a dependency is known to be down (circuit open), failing messages are parked after a
   *   single try.
   * - `groupId.retry` on those retry topics (this consumer's own, see SubscribeOptions.retryNamespace): a
   *   message that is not due yet pauses its partition (no sleeping inside the handler), and is retried when
   *   due; after the last hop it is dead-lettered. The original topic is derived from the retry topic's name,
   *   never from the message, and anything that is not a valid envelope goes to the original topic's dlq.
   * Persistent/poison failures: `maxAttempts` tries, then `<topic>.dlq`. Handlers keep the consumer's
   * session alive with periodic heartbeats while they run.
   */
  public subscribe(
    groupId: string,
    topics: string[],
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions
  ): void {
    if (!RETRY_NAMESPACE.test(options?.retryNamespace ?? '')) {
      throw new Error(`Invalid Kafka retry namespace '${options?.retryNamespace ?? ''}' (lowercase letters, digits and dashes)`);
    }
    this.startConsumer(groupId, new Map(topics.map((t) => [t, t])), messageHandler, options, 'main');
    this.startConsumer(
      `${groupId}.retry`,
      new Map(topics.map((t) => [retryTopicFor(options.retryNamespace, t), t])),
      messageHandler,
      options,
      'retry'
    );
  }

  /** `routes` maps every consumed topic to the original topic its messages belong to */
  private startConsumer(
    groupId: string,
    routes: Map<string, string>,
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions,
    mode: 'main' | 'retry'
  ): void {
    this.consumerState.set(groupId, 'starting');
    let attempt = 0;
    const startOnce = async (): Promise<void> => {
      try {
        await this.runConsumer(groupId, routes, messageHandler, options, mode);
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
    routes: Map<string, string>,
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions,
    mode: 'main' | 'retry'
  ): Promise<void> {
    const topics = [...routes.keys()];
    const maxAttempts = options.maxAttempts ?? 5;
    const transientBudgetMs = options.transientBudgetMs ?? Number(process.env.KAFKA_TRANSIENT_BUDGET_MS || 15_000);
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const maxRetryDelayMs = Math.max(0, ...retryDelaysMs);
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3_000;
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000 });
    // Circuit breaker: after a message exhausted its transient budget, assume the dependency is down
    let circuitOpenUntil = 0;

    consumer.on(consumer.events.CRASH, (event) => {
      if (this.stopping) return;
      // Not consuming until it rejoins the group (GROUP_JOIN flips it back), so /health reports it
      this.consumerState.set(groupId, 'crashed');
      if (event.payload.restart) {
        logger.warn({ groupId, err: event.payload.error }, 'Kafka consumer crashed; KafkaJS is restarting it');
        return;
      }
      // KafkaJS gave up: restart it ourselves
      logger.error({ groupId, err: event.payload.error }, 'Kafka consumer crashed permanently; restarting');
      this.consumers = this.consumers.filter((c) => c !== consumer);
      consumer.disconnect().catch(() => {});
      setTimeout(() => {
        if (!this.stopping) this.startConsumer(groupId, routes, messageHandler, options, mode);
      }, 5_000).unref();
    });
    consumer.on(consumer.events.GROUP_JOIN, () => this.consumerState.set(groupId, 'running'));
    consumer.on(consumer.events.FETCH, () => this.lastFetch.set(groupId, Date.now()));
    consumer.on(consumer.events.HEARTBEAT, () => this.lastFetch.set(groupId, Date.now()));

    await consumer.connect();
    for (const topic of topics) {
      // fromBeginning only matters for a brand-new consumer group: it must not miss events published
      // before its first start. Handlers are idempotent (processed-event tables), so a replay is safe.
      await consumer.subscribe({ topic, fromBeginning: process.env.KAFKA_FROM_BEGINNING !== 'false' });
    }

    await consumer.run({
      autoCommit: false,
      // Partitions are independent (ordering is per key, i.e. per partition), so process them in parallel
      partitionsConsumedConcurrently: Number(process.env.KAFKA_PARTITIONS_CONCURRENCY || 3),
      eachMessage: async ({ topic, partition, message, heartbeat }: EachMessagePayload) => {
        const commit = () =>
          consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
        const key = message.key?.toString();
        const originalTopic = routes.get(topic);
        if (!originalTopic) {
          // Only subscribed topics are delivered; never route anything based on an unknown name
          logger.error({ topic, offset: message.offset }, 'Kafka message from an unexpected topic skipped');
          await commit();
          return;
        }
        const rawValue = message.value?.toString();
        if (!rawValue) {
          await commit();
          return;
        }

        // Garbage goes to the ORIGINAL topic's dead-letter topic (retry topics have no dlq of their own)
        let parsed: any;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          logger.error({ topic, offset: message.offset }, 'Malformed JSON Kafka message routed to DLQ');
          await this.sendToDlq(originalTopic, key, rawValue, 'Malformed JSON');
          await commit();
          return;
        }

        let payload: any = parsed;
        let hop = 0;
        if (mode === 'retry') {
          const envelope = parseRetryEnvelope(parsed, originalTopic, retryDelaysMs.length);
          if (!envelope) {
            logger.error({ topic, offset: message.offset }, 'Invalid retry envelope routed to DLQ');
            await this.sendToDlq(originalTopic, key, rawValue, `Invalid retry envelope on ${topic}`);
            await commit();
            return;
          }
          payload = envelope.payload;
          hop = envelope.hop;
          // A message is never held longer than the longest retry delay after it was parked, so a bad retryAt
          // can't stall its partition (the parked time is the record timestamp, capped at now)
          const parkedAt = Math.min(Number(message.timestamp) || Date.now(), Date.now());
          const retryAt = Math.min(envelope.retryAt, parkedAt + maxRetryDelayMs);
          const waitMs = retryAt - Date.now();
          if (waitMs > 0) {
            // Not due yet: rewind to this message, pause the partition and resume when it is due
            consumer.seek({ topic, partition, offset: message.offset });
            consumer.pause([{ topic, partitions: [partition] }]);
            setTimeout(() => consumer.resume([{ topic, partitions: [partition] }]), Math.min(waitMs, 60_000)).unref();
            return;
          }
        }

        const correlationId = payload?.correlationId || message.headers?.['x-correlation-id']?.toString();
        // With the circuit open the dependency is known to be down: one try, then park
        const budget = Date.now() < circuitOpenUntil ? 0 : transientBudgetMs;
        const transientDeadline = Date.now() + budget;

        // A slow handler (e.g. SMTP at its timeouts) must not cost the consumer its group membership
        const handle = async () => {
          const beat = setInterval(() => void heartbeat().catch(() => {}), heartbeatIntervalMs);
          beat.unref?.();
          try {
            await messageHandler(originalTopic, payload, correlationId);
          } finally {
            clearInterval(beat);
          }
        };

        let failures = 0;
        let transientRetries = 0;
        let lastError: unknown;
        for (;;) {
          if (this.stopping) throw new Error('Consumer stopping; message will be redelivered');
          try {
            await handle();
            circuitOpenUntil = 0;
            await commit();
            consumed.inc({ topic: originalTopic, result: 'ok' });
            return;
          } catch (error) {
            lastError = error;
            const transient = isTransientError(error);
            if (transient) transientRetries++;
            else failures++;
            logger.warn(
              {
                err: redactErrorForLog(error),
                topic: originalTopic,
                partition,
                offset: message.offset,
                transient,
                failures,
                transientRetries,
                hop,
              },
              'Consumer processing error'
            );
            if (!transient && failures >= maxAttempts) break;
            if (transient && Date.now() >= transientDeadline) {
              circuitOpenUntil = Date.now() + 30_000;
              // Don't block the partition: park the message on this consumer's retry topic and move on
              if (hop < retryDelaysMs.length) {
                const envelope: RetryEnvelope = {
                  __retry: 1,
                  originalTopic,
                  hop: hop + 1,
                  retryAt: Date.now() + retryDelaysMs[hop],
                  lastError: errorText(error).slice(0, 500),
                  payload,
                };
                await this.publishEvent(retryTopicFor(options.retryNamespace, originalTopic), key || 'unknown', envelope);
                logger.warn({ topic: originalTopic, hop: hop + 1 }, 'Message moved to retry topic after transient failures');
                await commit();
                consumed.inc({ topic: originalTopic, result: 'retry' });
                return;
              }
              break; // retry hops exhausted: dead-letter
            }
            const delay = transient
              ? Math.min(500 * 2 ** Math.min(transientRetries, 6), 5_000)
              : Math.min(200 * 2 ** failures, 5_000);
            await new Promise((r) => setTimeout(r, delay));
            await heartbeat().catch(() => {});
          }
        }

        await this.sendToDlq(originalTopic, key, JSON.stringify(payload), errorText(lastError));
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
    const failureReason = redactEmails(reason).slice(0, 1000);
    await this.publishEvent(`${topic}.dlq`, key || 'unknown', {
      originalTopic: topic,
      failureReason,
      failedAt: new Date().toISOString(),
      rawValue,
    });
    consumed.inc({ topic, result: 'dlq' });
    logger.error({ topic, reason: failureReason }, 'Message routed to dead-letter topic');
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
