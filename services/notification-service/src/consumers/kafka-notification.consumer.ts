import { Consumer } from 'kafkajs';
import { KafkaService, logger } from '@banksphere/common';
import { NotificationService } from '../services/notification.service';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  AccountStatusChangedEvent,
  FraudAlertCreatedEvent,
  UserRegisteredEvent,
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
      'user.registered.v1',
      'transaction.completed.v1',
      'account.created.v1',
      'account.status.changed.v1',
      'fraud.alert.created.v1',
    ];

    this.consumer = await this.kafkaService.subscribe(
      this.groupId,
      topics,
      async (topic: string, payload: any) => {
        if (typeof payload?.eventId !== 'string') {
          // Poison message: skip (offset is committed) rather than block the partition forever
          logger.error({ topic }, 'Event without eventId skipped');
          return;
        }

        switch (topic) {
          case 'user.registered.v1':
            await this.notificationService.handleUserRegistered(payload as UserRegisteredEvent);
            break;

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

          case 'account.status.changed.v1':
            await this.notificationService.handleAccountStatusChanged(
              payload as AccountStatusChangedEvent
            );
            break;

          case 'fraud.alert.created.v1':
            await this.notificationService.handleFraudAlert(
              payload as FraudAlertCreatedEvent
            );
            break;

          default:
            logger.warn({ topic }, 'Unhandled notification topic');
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
