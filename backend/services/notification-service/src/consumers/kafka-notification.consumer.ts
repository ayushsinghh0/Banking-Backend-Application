import { KafkaService, logger } from '@banksphere/common';
import { NotificationService } from '../services/notification.service';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  AccountStatusChangedEvent,
  FraudAlertCreatedEvent,
  UserRegisteredEvent,
  WithdrawalCodeCreatedEvent,
  BeneficiaryAddedEvent,
  PaymentUpdatedEvent,
  NewDeviceLoginEvent,
} from '../types';

export class KafkaNotificationConsumer {
  constructor(
    private readonly kafkaService: KafkaService,
    private readonly notificationService: NotificationService,
    private readonly groupId = process.env.KAFKA_CONSUMER_GROUP || 'notification-service-group'
  ) {}

  public start(): void {
    const topics = [
      'user.registered.v1',
      'transaction.completed.v1',
      'account.created.v1',
      'account.status.changed.v1',
      'fraud.alert.created.v1',
      'withdrawal.code.created.v1',
      'beneficiary.added.v1',
      'payment.updated.v1',
      'security.new_device_login.v1',
    ];

    this.kafkaService.subscribe(
      this.groupId,
      topics,
      async (topic: string, payload: any) => {
        if (typeof payload?.eventId !== 'string') {
          // Poison message: non-transient error -> retried a few times, then dead-lettered
          throw new Error(`Event without eventId on ${topic}`);
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

          case 'withdrawal.code.created.v1':
            await this.notificationService.handleWithdrawalCodeCreated(payload as WithdrawalCodeCreatedEvent);
            break;

          case 'beneficiary.added.v1':
            await this.notificationService.handleBeneficiaryAdded(payload as BeneficiaryAddedEvent);
            break;

          case 'payment.updated.v1':
            await this.notificationService.handlePaymentUpdated(payload as PaymentUpdatedEvent);
            break;

          case 'security.new_device_login.v1':
            await this.notificationService.handleNewDeviceLogin(payload as NewDeviceLoginEvent);
            break;

          default:
            logger.warn({ topic }, 'Unhandled notification topic');
        }
      },
      // Retries are parked on notification.<topic>.retry, which only notification-svc may write and read
      { retryNamespace: 'notification' }
    );
  }

}
