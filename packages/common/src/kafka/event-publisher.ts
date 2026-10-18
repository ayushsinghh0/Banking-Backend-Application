import { KafkaService } from './kafka-client';
import { logger } from '../logger/logger';

export interface EventPublisher {
  publish(topic: string, key: string, payload: unknown): Promise<void>;
}

export function isKafkaEnabled(): boolean {
  return process.env.KAFKA_ENABLED !== 'false';
}

/**
 * Returns a Kafka-backed publisher, or null when Kafka is disabled (KAFKA_ENABLED=false).
 * Callers must treat null as "do not publish" — never as "pretend it was published",
 * otherwise outbox rows get marked PUBLISHED and the events are silently lost.
 */
export function createEventPublisher(clientId: string): {
  publisher: EventPublisher | null;
  kafka: KafkaService | null;
} {
  if (!isKafkaEnabled()) {
    logger.warn({ clientId }, 'KAFKA_ENABLED=false: domain events will not be published');
    return { publisher: null, kafka: null };
  }
  const kafka = new KafkaService({
    clientId,
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  });
  return {
    kafka,
    publisher: {
      publish: (topic, key, payload) => kafka.publishEvent(topic, key, payload),
    },
  };
}
