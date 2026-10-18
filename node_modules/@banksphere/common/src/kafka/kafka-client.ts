import { Kafka, Producer, Consumer, EachMessagePayload, logLevel } from 'kafkajs';
import { logger } from '../logger/logger';

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
}

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumers: Consumer[] = [];

  constructor(config?: KafkaConfig) {
    const clientId = config?.clientId || process.env.KAFKA_CLIENT_ID || 'banksphere-service';
    const brokers = config?.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']);

    this.kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.ERROR,
      retry: {
        initialRetryTime: 300,
        retries: 8,
      },
    });
  }

  public async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer({
        idempotent: true, // Guarantees producer message deduplication & in-order delivery
        maxInFlightRequests: 1,
      });
      await this.producer.connect();
      logger.info('Kafka idempotent producer connected');
    }
    return this.producer;
  }

  public async publishEvent(topic: string, key: string, payload: any): Promise<void> {
    const producer = await this.getProducer();
    await producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(payload),
          timestamp: Date.now().toString(),
        },
      ],
    });
  }

  public async subscribe(
    groupId: string,
    topics: string[],
    messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>
  ): Promise<Consumer> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();

    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      autoCommit: false, // Manual commit ensures we only commit after successful processing!
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        const rawValue = message.value?.toString();
        if (!rawValue) return;

        let parsed: any;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          logger.error({ rawValue, topic }, 'Failed to parse malformed JSON Kafka message');
          await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
          return;
        }

        const correlationId = parsed?.correlationId || message.headers?.['x-correlation-id']?.toString();

        try {
          await messageHandler(topic, parsed, correlationId);
          // Commit offset upon verified success
          await consumer.commitOffsets([
            { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
          ]);
        } catch (error) {
          logger.error(
            { error, topic, partition, offset: message.offset, correlationId },
            'Consumer processing error'
          );
          throw error; // KafkaJS will trigger retry backoff
        }
      },
    });

    this.consumers.push(consumer);
    logger.info({ groupId, topics }, 'Kafka consumer subscribed and listening');
    return consumer;
  }

  public async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
    this.consumers = [];
  }
}
