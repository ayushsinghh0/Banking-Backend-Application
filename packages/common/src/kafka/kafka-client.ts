import { Kafka, Producer, Consumer, EachMessagePayload, logLevel, Partitioners, LogEntry } from 'kafkajs';
import { logger } from '../logger/logger';

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
}

export interface SubscribeOptions {
  /** In-process attempts per message before it is routed to the dead-letter topic */
  maxAttempts?: number;
}

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private producerConnecting: Promise<Producer> | null = null;
  private consumers: Consumer[] = [];

  constructor(config?: KafkaConfig) {
    const clientId = config?.clientId || process.env.KAFKA_CLIENT_ID || 'banksphere-service';
    const brokers = config?.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']);

    this.kafka = new Kafka({
      clientId,
      brokers,
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
        retries: 8,
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
   * Subscribes with manual offset commits. A message whose handler keeps failing is retried
   * in-process with backoff, then published to `<topic>.dlq` and committed, so one poison message
   * can never block its partition forever.
   */
  public async subscribe(
    groupId: string,
    topics: string[],
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>,
    options: SubscribeOptions = {}
  ): Promise<Consumer> {
    const maxAttempts = options.maxAttempts ?? 5;
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();

    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: true });
    }

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
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

        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await messageHandler(topic, parsed, correlationId);
            await commit();
            return;
          } catch (error) {
            lastError = error;
            logger.warn(
              { err: error, topic, partition, offset: message.offset, attempt, maxAttempts },
              'Consumer processing error'
            );
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** attempt, 5_000)));
            }
          }
        }

        await this.sendToDlq(topic, message.key?.toString(), rawValue, String((lastError as any)?.message ?? lastError));
        await commit();
      },
    });

    this.consumers.push(consumer);
    logger.info({ groupId, topics }, 'Kafka consumer subscribed and listening');
    return consumer;
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
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
    this.consumers = [];
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }
}
