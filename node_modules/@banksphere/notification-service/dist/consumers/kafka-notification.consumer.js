"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KafkaNotificationConsumer = void 0;
class KafkaNotificationConsumer {
    kafkaService;
    notificationService;
    groupId;
    consumer = null;
    constructor(kafkaService, notificationService, groupId = process.env.KAFKA_CONSUMER_GROUP || 'notification-service-group') {
        this.kafkaService = kafkaService;
        this.notificationService = notificationService;
        this.groupId = groupId;
    }
    async start() {
        const topics = [
            'transaction.completed.v1',
            'account.created.v1',
            'fraud.alert.created.v1',
        ];
        this.consumer = await this.kafkaService.subscribe(this.groupId, topics, async (topic, payload) => {
            switch (topic) {
                case 'transaction.completed.v1':
                    await this.notificationService.handleTransactionCompleted(payload);
                    break;
                case 'account.created.v1':
                    await this.notificationService.handleAccountCreated(payload);
                    break;
                case 'fraud.alert.created.v1':
                    await this.notificationService.handleFraudAlert(payload);
                    break;
                default:
                    console.warn(`[KafkaNotificationConsumer] Unhandled topic: ${topic}`);
            }
        });
    }
    async stop() {
        if (this.consumer) {
            await this.consumer.disconnect();
            this.consumer = null;
        }
    }
}
exports.KafkaNotificationConsumer = KafkaNotificationConsumer;
