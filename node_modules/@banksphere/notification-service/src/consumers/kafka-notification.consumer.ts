import { Consumer } from 'kafkajs';
import { KafkaService } from '@banksphere/common';
import { NotificationService } from '../services/notification.service';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  FraudAlertCreatedEvent,
} from '../types';

export class KafkaNotificationConsumer {
  private consumer: Consumer | null = null;

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly notificationService: NotificationService,
    private readonly groupId = process.env.KAFKA_CONSUMER_GROUP || 'notification-service-group'
  ) {}

  public async start(): Promise<void> {
    const topics = [
      'transaction.completed.v1',
      'account.created.v1',
      'fraud.alert.created.v1',
    ];

    this.consumer = await this.kafkaService.subscribe(
      this.groupId,
      topics,
      async (topic: string, payload: any) => {
        switch (topic) {
          case 'transaction.completed.v1':
            await this.notificationService.handleTransactionCompleted(
              payload as TransactionCompletedEvent
            );
            break;

          case 'account.created.v1':
            await this.notificationService.handleAccountCreated(
              payload as AccountCreatedEvent
            );
            break;

          case 'fraud.alert.created.v1':
            await this.notificationService.handleFraudAlert(
              payload as FraudAlertCreatedEvent
            );
            break;

          default:
            console.warn(`[KafkaNotificationConsumer] Unhandled topic: ${topic}`);
        }
      }
    );
  }

  public async stop(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }
  }
}
