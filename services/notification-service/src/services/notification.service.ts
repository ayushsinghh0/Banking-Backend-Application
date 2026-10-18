import { PrismaClient, NotificationStatus, NotificationChannel } from '../../generated/client';
import { EmailProvider } from '../providers/email.provider';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  AccountStatusChangedEvent,
  FraudAlertCreatedEvent,
  UserRegisteredEvent,
  EmailDispatchOptions,
} from '../types';
import { MoneyUtil, logger } from '@banksphere/common';

export interface KafkaDLQPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

/**
 * Masks an account number for display in emails: 100112345678 -> XXXXXXXX5678
 */
function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4 ? `${'X'.repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}` : accountNumber;
}

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emailProvider: EmailProvider,
    private readonly dlqPublisher?: KafkaDLQPublisher | null,
    private readonly maxRetries = Number(process.env.MAX_NOTIFICATION_RETRIES || 3),
    private readonly securityTeamEmail = process.env.SECURITY_ALERT_EMAIL || 'security-team@banksphere.com',
    private readonly dlqTopic = process.env.KAFKA_DLQ_TOPIC || 'notifications.dlq'
  ) {}

  /**
   * Evaluates if a Kafka event was already processed to guarantee consumer idempotency
   */
  public async isEventProcessed(eventId: string): Promise<boolean> {
    const existing = await this.prisma.processedEvent.findUnique({
      where: { eventId },
    });
    return !!existing;
  }

  /**
   * Marks an event as processed. A unique violation means another consumer instance
   * finished the same event concurrently, which is fine for at-least-once delivery.
   */
  private async markEventProcessed(eventId: string, eventType: string): Promise<void> {
    try {
      await this.prisma.processedEvent.create({
        data: { eventId, eventType },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }
  }

  private async resolveEmail(userId?: string): Promise<string | null> {
    if (!userId) return null;
    const contact = await this.prisma.userContact.findUnique({ where: { userId } });
    return contact?.email ?? null;
  }

  private async resolveAccountOwnerEmail(accountId?: string, customerId?: string): Promise<string | null> {
    if (customerId) return this.resolveEmail(customerId);
    if (!accountId) return null;
    const owner = await this.prisma.accountOwner.findUnique({ where: { accountId } });
    return this.resolveEmail(owner?.customerId);
  }

  /**
   * Handles 'user.registered.v1': maintains the local email directory (no email is sent)
   */
  public async handleUserRegistered(event: UserRegisteredEvent): Promise<boolean> {
    await this.prisma.userContact.upsert({
      where: { userId: event.userId },
      create: { userId: event.userId, email: event.email },
      update: { email: event.email },
    });
    return true;
  }

  /**
   * Handles 'transaction.completed.v1' Kafka event idempotently: each party is told about their side
   */
  public async handleTransactionCompleted(event: TransactionCompletedEvent): Promise<boolean> {
    if (await this.isEventProcessed(event.eventId)) {
      logger.info({ eventId: event.eventId }, 'Duplicate notification event skipped');
      return false;
    }

    const formattedAmount = MoneyUtil.formatINR(event.amountInPaise);
    const parties: Array<{ email: string | null; direction: 'debited from' | 'credited to' }> = [];

    if (event.sourceAccountId) {
      parties.push({
        email: await this.resolveAccountOwnerEmail(event.sourceAccountId, event.sourceCustomerId),
        direction: 'debited from',
      });
    }
    if (event.destinationAccountId) {
      parties.push({
        email: await this.resolveAccountOwnerEmail(event.destinationAccountId, event.destinationCustomerId),
        direction: 'credited to',
      });
    }

    for (const party of parties) {
      if (!party.email) {
        logger.warn({ eventId: event.eventId }, 'No contact on file for transaction party; notification skipped');
        continue;
      }
      await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, {
        recipient: party.email,
        subject: `BankSphere Alert: ${formattedAmount} ${party.direction} your account`,
        body: `Dear Customer,\n\n${formattedAmount} has been ${party.direction} your account (${event.type}).\n\nTransaction Reference: ${event.referenceId}\nTimestamp: ${event.timestamp}\n\nIf you did not authorise this transaction, contact BankSphere immediately.\n\nThank you for banking with BankSphere.`,
        metadata: { transactionId: event.transactionId, referenceId: event.referenceId },
      });
    }

    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Handles 'account.created.v1' Kafka event idempotently
   */
  public async handleAccountCreated(event: AccountCreatedEvent): Promise<boolean> {
    // Always refresh the read model, even for a duplicate event (upsert is idempotent)
    await this.prisma.accountOwner.upsert({
      where: { accountId: event.accountId },
      create: {
        accountId: event.accountId,
        customerId: event.customerId,
        accountNumber: event.accountNumber,
      },
      update: {},
    });

    if (await this.isEventProcessed(event.eventId)) {
      logger.info({ eventId: event.eventId }, 'Duplicate notification event skipped');
      return false;
    }

    const recipient = await this.resolveEmail(event.customerId);
    if (recipient) {
      await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, {
        recipient,
        subject: 'Welcome to BankSphere! Your New Account Details',
        body: `Dear Customer,\n\nYour new ${event.accountType} account has been successfully opened!\n\nAccount Number: ${maskAccountNumber(event.accountNumber)}\nCurrency: ${event.currency}\n\nThank you for choosing BankSphere.`,
        metadata: { accountId: event.accountId },
      });
    } else {
      logger.warn({ eventId: event.eventId }, 'No contact on file for account owner; welcome email skipped');
    }

    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Handles 'account.status.changed.v1': tells the customer their account was frozen / unfrozen / closed
   */
  public async handleAccountStatusChanged(event: AccountStatusChangedEvent): Promise<boolean> {
    if (await this.isEventProcessed(event.eventId)) {
      return false;
    }

    const recipient = await this.resolveEmail(event.customerId);
    if (recipient) {
      await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, {
        recipient,
        subject: `BankSphere: your account is now ${event.status}`,
        body: `Dear Customer,\n\nThe status of one of your accounts changed from ${event.previousStatus} to ${event.status}.\n\nIf you did not request this change, contact BankSphere immediately.`,
        metadata: { accountId: event.accountId },
      });
    }

    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Handles 'fraud.alert.created.v1' Kafka event idempotently
   */
  public async handleFraudAlert(event: FraudAlertCreatedEvent): Promise<boolean> {
    if (await this.isEventProcessed(event.eventId)) {
      logger.info({ eventId: event.eventId }, 'Duplicate notification event skipped');
      return false;
    }

    const emailOptions: EmailDispatchOptions = {
      recipient: this.securityTeamEmail,
      subject: `URGENT SECURITY ALERT: [${event.severity}] Risk Activity Detected`,
      body: `Security Operations Alert,\n\nA transaction has triggered risk rule evaluation.\n\nTransaction ID: ${event.transactionId}\nAccount ID: ${event.accountId}\nSeverity: ${event.severity}\nReason: ${event.reason}\n\nPlease review immediately.`,
      metadata: { alertId: event.alertId, transactionId: event.transactionId },
    };

    await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, emailOptions);
    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Dispatches notifications with bounded exponential backoff retries and Dead-Letter Queue (DLQ) routing
   */
  public async dispatchWithRetryAndDLQ(
    eventId: string,
    eventType: string,
    options: EmailDispatchOptions
  ): Promise<void> {
    let attempt = 0;
    let lastErrorMsg = '';

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        await this.emailProvider.sendEmail(options);

        // Record successful dispatch
        await this.prisma.notificationLog.create({
          data: {
            recipient: options.recipient,
            channel: NotificationChannel.EMAIL,
            subject: options.subject,
            body: options.body,
            status: NotificationStatus.SENT,
            retryCount: attempt - 1,
            metadata: options.metadata,
          },
        });
        return; // Success!
      } catch (err: any) {
        lastErrorMsg = err?.message || 'Email delivery failure';
        logger.warn({ eventId, attempt, maxRetries: this.maxRetries }, `Notification attempt failed: ${lastErrorMsg}`);

        if (attempt < this.maxRetries) {
          // Exponential backoff delay: 100ms * 2^attempt
          const backoffMs = 100 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    // RETRIES EXHAUSTED: Route to Dead-Letter Log & DLQ Topic
    logger.error({ eventId }, 'Max notification retries exhausted. Routing to Dead-Letter Queue.');

    await this.prisma.notificationLog.create({
      data: {
        recipient: options.recipient,
        channel: NotificationChannel.EMAIL,
        subject: options.subject,
        body: options.body,
        status: NotificationStatus.DEAD_LETTER,
        retryCount: attempt,
        lastError: lastErrorMsg,
        metadata: options.metadata,
      },
    });

    if (this.dlqPublisher) {
      try {
        await this.dlqPublisher.publish(this.dlqTopic, eventId, {
          originalEventId: eventId,
          originalEventType: eventType,
          failureReason: lastErrorMsg,
          payload: options,
          failedAt: new Date().toISOString(),
        });
      } catch (dlqErr) {
        logger.error({ err: dlqErr, eventId }, 'Failed to publish message to DLQ topic');
      }
    }
  }

  /**
   * Queries notification history for audit
   */
  public async getNotificationLogs(recipient?: string, limit = 20, offset = 0) {
    return this.prisma.notificationLog.findMany({
      where: recipient ? { recipient } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
