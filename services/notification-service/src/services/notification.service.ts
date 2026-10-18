import { PrismaClient, NotificationStatus, NotificationChannel } from '../../generated/client';
import { EmailProvider } from '../providers/email.provider';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  AccountStatusChangedEvent,
  FraudAlertCreatedEvent,
  UserRegisteredEvent,
  WithdrawalCodeCreatedEvent,
  EmailDispatchOptions,
} from '../types';
import { MoneyUtil, TransientError, isTransientError, logger } from '@banksphere/common';

export interface KafkaDLQPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

/**
 * Masks an account number for display in emails: 100112345678 -> XXXXXXXX5678
 */
function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4 ? `${'X'.repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}` : accountNumber;
}

/** How long to keep retrying an event whose recipient's contact details haven't arrived yet */
const CONTACT_WAIT_MS = 15 * 60 * 1000;

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
   * Events travel on different topics, so a transaction alert can arrive before the owner's
   * user.registered event. Retry for a while (transient) rather than silently dropping a mandatory alert.
   */
  private contactMissing(eventId: string, eventTimestamp: string | undefined): void {
    const age = Date.now() - new Date(eventTimestamp ?? Date.now()).getTime();
    if (age < CONTACT_WAIT_MS) {
      throw new TransientError(`Contact details not yet available for event ${eventId}`);
    }
    logger.error({ eventId, alert: 'NOTIFICATION_RECIPIENT_UNKNOWN' }, 'No contact on file for recipient; notification skipped');
  }

  /**
   * Handles 'user.registered.v1': maintains the local email directory (no email is sent).
   * Insert-only: an event can never overwrite an existing user's address (a forged or replayed event
   * must not be able to redirect someone's bank notifications).
   */
  public async handleUserRegistered(event: UserRegisteredEvent): Promise<boolean> {
    if (typeof event.userId !== 'string' || typeof event.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(event.email)) {
      throw new Error('Malformed user.registered.v1 event');
    }
    const result = await this.prisma.userContact.createMany({
      data: [{ userId: event.userId, email: event.email }],
      skipDuplicates: true,
    });
    if (result.count === 0) {
      const existing = await this.prisma.userContact.findUnique({ where: { userId: event.userId } });
      if (existing && existing.email !== event.email) {
        logger.warn({ userId: event.userId, alert: 'CONTACT_OVERWRITE_ATTEMPT' }, 'Ignored user.registered.v1 with a different email');
      }
    }
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
        this.contactMissing(event.eventId, event.timestamp);
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
    // Always refresh the read model, even for a duplicate event (insert-only, idempotent)
    await this.prisma.accountOwner.createMany({
      data: [{ accountId: event.accountId, customerId: event.customerId, accountNumber: event.accountNumber }],
      skipDuplicates: true,
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
      this.contactMissing(event.eventId, event.timestamp);
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
    } else {
      this.contactMissing(event.eventId, event.timestamp);
    }

    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /** A cash withdrawal code was created: tell the customer, in case it wasn't them */
  public async handleWithdrawalCodeCreated(event: WithdrawalCodeCreatedEvent): Promise<boolean> {
    if (await this.isEventProcessed(event.eventId)) {
      return false;
    }
    const recipient = await this.resolveEmail(event.customerId);
    if (recipient) {
      await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, {
        recipient,
        subject: 'BankSphere: a cash withdrawal code was created',
        body: `Dear Customer,\n\nA one-time code to withdraw ${MoneyUtil.formatINR(event.amountInPaise)} in cash at a branch was created from your online banking session. It expires at ${event.expiresAt}.\n\nIf this was not you, contact BankSphere immediately and change your password.`,
        metadata: { accountId: event.accountId },
      });
    } else {
      this.contactMissing(event.eventId, event.timestamp);
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
      body: `Security Operations team,\n\nA transaction has triggered risk rule evaluation.\n\nTransaction ID: ${event.transactionId}\nAccount ID: ${event.accountId}\nSeverity: ${event.severity}\nReason: ${event.reason}\n\nPlease review immediately.`,
      metadata: { alertId: event.alertId, transactionId: event.transactionId },
    };

    await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, emailOptions);
    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Sends one email for (event, recipient) at most once across retries and redeliveries, with bounded
   * in-process retries. Outcomes:
   * - sent                         -> SENT log + delivery record
   * - transient failure (SMTP down / 4xx / network) -> TransientError: the Kafka message is retried later
   * - permanent failure (e.g. 5xx rejected recipient) -> DEAD_LETTER log + notifications.dlq
   */
  public async dispatchWithRetryAndDLQ(
    eventId: string,
    eventType: string,
    options: EmailDispatchOptions
  ): Promise<void> {
    const delivered = await this.prisma.notificationDelivery.findUnique({
      where: { eventId_recipient: { eventId, recipient: options.recipient } },
    });
    if (delivered) {
      logger.info({ eventId }, 'Notification already delivered to this recipient; not resending');
      return;
    }

    let attempt = 0;
    let lastError: any;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        await this.emailProvider.sendEmail(options);
        await this.prisma.$transaction([
          this.prisma.notificationDelivery.create({ data: { eventId, recipient: options.recipient } }),
          this.prisma.notificationLog.create({
            data: {
              recipient: options.recipient,
              channel: NotificationChannel.EMAIL,
              subject: options.subject,
              body: options.body,
              status: NotificationStatus.SENT,
              retryCount: attempt - 1,
              metadata: options.metadata,
            },
          }),
        ]);
        return;
      } catch (err: any) {
        if (err?.code === 'P2002') return; // a concurrent consumer recorded the same delivery
        lastError = err;
        logger.warn(
          { eventId, attempt, maxRetries: this.maxRetries, transient: isTransientError(err) },
          `Notification attempt failed: ${err?.message || 'Email delivery failure'}`
        );
        if (attempt < this.maxRetries) {
          const backoffMs = 100 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    if (isTransientError(lastError)) {
      // The mail server (not the message) is the problem: let Kafka redeliver later, never dead-letter
      throw new TransientError(`Email provider unavailable: ${lastError?.message}`);
    }

    const lastErrorMsg = lastError?.message || 'Email delivery failure';
    logger.error({ eventId }, 'Permanent notification failure. Routing to Dead-Letter Queue.');

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
          recipient: options.recipient,
          subject: options.subject,
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
