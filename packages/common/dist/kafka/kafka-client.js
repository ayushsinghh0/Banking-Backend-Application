"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KafkaService = void 0;
const kafkajs_1 = require("kafkajs");
const logger_1 = require("../logger/logger");
class KafkaService {
    kafka;
    producer = null;
    consumers = [];
    constructor(config) {
        const clientId = config?.clientId || process.env.KAFKA_CLIENT_ID || 'banksphere-service';
        const brokers = config?.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']);
        this.kafka = new kafkajs_1.Kafka({
            clientId,
            brokers,
            logLevel: kafkajs_1.logLevel.ERROR,
            retry: {
                initialRetryTime: 300,
                retries: 8,
            },
        });
    }
    async getProducer() {
        if (!this.producer) {
            this.producer = this.kafka.producer({
                idempotent: true, // Guarantees producer message deduplication & in-order delivery
                maxInFlightRequests: 1,
            });
            await this.producer.connect();
            logger_1.logger.info('Kafka idempotent producer connected');
        }
        return this.producer;
    }
    async publishEvent(topic, key, payload) {
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
    async subscribe(groupId, topics, messageHandler) {
        const consumer = this.kafka.consumer({ groupId });
        await consumer.connect();
        for (const topic of topics) {
            await consumer.subscribe({ topic, fromBeginning: false });
        }
        await consumer.run({
            autoCommit: false, // Manual commit ensures we only commit after successful processing!
            eachMessage: async ({ topic, partition, message }) => {
                const rawValue = message.value?.toString();
                if (!rawValue)
                    return;
                let parsed;
                try {
                    parsed = JSON.parse(rawValue);
                }
                catch {
                    logger_1.logger.error({ rawValue, topic }, 'Failed to parse malformed JSON Kafka message');
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
                }
                catch (error) {
                    logger_1.logger.error({ error, topic, partition, offset: message.offset, correlationId }, 'Consumer processing error');
                    throw error; // KafkaJS will trigger retry backoff
                }
            },
        });
        this.consumers.push(consumer);
        logger_1.logger.info({ groupId, topics }, 'Kafka consumer subscribed and listening');
        return consumer;
    }
    async disconnect() {
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
exports.KafkaService = KafkaService;
//# sourceMappingURL=kafka-client.js.map