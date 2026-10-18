"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KafkaFraudConsumer = void 0;
class KafkaFraudConsumer {
    kafkaService;
    fraudService;
    groupId;
    consumer = null;
    constructor(kafkaService, fraudService, groupId = process.env.KAFKA_CONSUMER_GROUP || 'fraud-service-group') {
        this.kafkaService = kafkaService;
        this.fraudService = fraudService;
        this.groupId = groupId;
    }
    async start() {
        this.consumer = await this.kafkaService.subscribe(this.groupId, ['transaction.completed.v1'], async (_topic, payload) => {
            const amountInPaise = BigInt(payload.amountInPaise || '0');
            const accountId = payload.sourceAccountId || payload.destinationAccountId || 'unknown-account';
            await this.fraudService.evaluateTransaction({
                transactionId: payload.transactionId,
                accountId,
                amountInPaise,
                timestamp: new Date(payload.timestamp || Date.now()),
            }, payload.eventId);
        });
    }
    async stop() {
        if (this.consumer) {
            await this.consumer.disconnect();
            this.consumer = null;
        }
    }
}
exports.KafkaFraudConsumer = KafkaFraudConsumer;
