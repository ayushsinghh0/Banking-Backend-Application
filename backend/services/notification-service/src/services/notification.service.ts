import { PrismaClient, NotificationStatus, NotificationChannel } from '../../generated/client';
import { EmailProvider } from '../providers/email.provider';
import {
  TransactionCompletedEvent,
  AccountCreatedEvent,
  AccountStatusChangedEvent,
  FraudAlertCreatedEvent,
  UserRegisteredEvent,
  WithdrawalCodeCreatedEvent,
  BeneficiaryAddedEvent,
  EmailDispatchOptions,
  NewDeviceLoginEvent,
  PaymentUpdatedEvent,
} from '../types';
import { MoneyUtil, TransientError, isTransientError, logger, redactEmails, redactErrorForLog } from '@banksphere/common';

export interface KafkaDLQPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

export interface NotificationServiceOptions {
  securityTeamEmail?: string;
  dlqTopic?: string;
  /** After an SMTP infrastructure failure, no email is attempted for this long (then one probe) */
  smtpCircuitOpenMs?: number;
}

/** Outcome of one email: sent now, already sent (or settled) earlier, or permanently rejected */
export type DispatchOutcome = 'SENT' | 'ALREADY_SENT' | 'DEAD_LETTER';

/**
 * Masks an account number for display in emails: 100112345678 -> XXXXXXXX5678
 */
function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length > 4 ? `${'X'.repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}` : accountNumber;
}

/** How long to keep retrying an event whose recipient's contact details haven't arrived yet */
const CONTACT_WAIT_MS = 15 * 60 * 1000;

/**
 * Circuit breaker for the mail server. While it is open no SMTP connection is attempted at all (each attempt
 * against a dead server costs its connection timeout); after the cool-down a single probe is let through.
 */
class SmtpCircuit {
  private openUntil = 0;
  private probing = false;

  constructor(private readonly openMs: number) {}

  /** True when this caller may talk to the mail server */
  public tryAcquire(): boolean {
    if (this.openUntil === 0) return true; // closed
    if (Date.now() < this.openUntil || this.probing) return false;
    this.probing = true; // half-open: exactly one probe
    return true;
  }

  /** The server answered (accepted or rejected this message) */
  public succeeded(): void {
    this.openUntil = 0;
    this.probing = false;
  }

  /** The mail infrastructure failed */
  public failed(): void {
    this.openUntil = Date.now() + this.openMs;
    this.probing = false;
  }

  /** A probe ended without reaching the server (e.g. the database failed first) */
  public release(): void {
    this.probing = false;
  }
}

/**
 * A customer-chosen label made safe for an email: no control characters (no paragraph/header injection), no
 * bidirectional overrides (no visual spoofing), bounded length. HTML escaping happens when it is rendered.
 */
function plainLabel(value: string, maxLength = 64): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned || 'Unnamed payee';
}

/** "2026-10-27T14:05:09.000Z" -> "2026-10-27 14:05 UTC" */
function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function emailDomain(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** India Standard Time is UTC+05:30 all year (no daylight saving) */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** "2026-10-28T14:05:09Z" -> "28 Oct 2026, 7:35 PM IST" (deterministic: no locale data involved) */
export function formatIst(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const hours = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${hour12}:${minutes} ${hours < 12 ? 'AM' : 'PM'} IST`;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Razorpay method codes in customer words; unknown codes are not echoed */
const METHOD_NAMES: Record<string, string> = { upi: 'UPI', card: 'card', netbanking: 'net banking', wallet: 'wallet', emi: 'EMI' };
const REFUND_DESTINATIONS: Record<string, string> = {
  upi: 'the UPI account you paid from',
  card: 'the card you paid with',
  netbanking: 'the bank account you paid from',
  wallet: 'the wallet you paid with',
  emi: 'the card you paid with',
};

function paymentMethodName(method: unknown): string {
  return (typeof method === 'string' && METHOD_NAMES[method.toLowerCase()]) || 'UPI, card or net banking';
}

function refundDestination(method: unknown): string {
  return (typeof method === 'string' && REFUND_DESTINATIONS[method.toLowerCase()]) || 'UPI, card or net banking';
}

/** Why a captured top-up could not be credited, in plain words; internal reasons are never shown as is */
function creditBlockedReason(reason: unknown): string {
  const code = typeof reason === 'string' ? reason.toUpperCase() : '';
  if (!/^[A-Z0-9_]{1,64}$/.test(code)) return '';
  if (code.includes('CLOSED')) return ' because the account is closed';
  if (/FROZEN|INACTIVE|NOT_CREDITABLE|BLOCKED/.test(code)) return " because the account can't receive money right now";
  if (/AMOUNT|MISMATCH/.test(code)) return " because the amount paid didn't match the top-up";
  return '';
}

/**
 * The device label of a sign-in, made safe to put in a security email: it comes from the User-Agent of
 * whoever signed in, so an attacker could otherwise write "call this number" or a link into our alert.
 */
function deviceLabelForEmail(value: unknown): string {
  // A small alphabet (no control, bidi, markup or quote characters), collapsed and bounded
  const label = (typeof value === 'string' ? value : '')
    .replace(/[^A-Za-z0-9 .()/+_,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  const looksLikeLinkOrNumber = /[A-Za-z0-9-]\.[A-Za-z]{2,}/.test(label) || /\d{6,}/.test(label.replace(/[\s()+-]/g, ''));
  return label && !looksLikeLinkOrNumber ? label : 'Unrecognised device';
}

/** A masked network ("203.0.113.x", "2001:db8:1::/48"); anything else is shown as unknown */
function networkForEmail(value: unknown): string {
  return typeof value === 'string' && /^[0-9A-Fa-fx.:/]{3,64}$/.test(value) ? value : 'unknown';
}

export class NotificationService {
  private readonly securityTeamEmail: string;
  private readonly dlqTopic: string;
  private readonly smtpCircuit: SmtpCircuit;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly emailProvider: EmailProvider,
    private readonly dlqPublisher?: KafkaDLQPublisher | null,
    options: NotificationServiceOptions = {}
  ) {
    this.securityTeamEmail = options.securityTeamEmail ?? (process.env.SECURITY_ALERT_EMAIL || 'security-team@banksphere.com');
    this.dlqTopic = options.dlqTopic ?? (process.env.KAFKA_DLQ_TOPIC || 'notifications.dlq');
    this.smtpCircuit = new SmtpCircuit(options.smtpCircuitOpenMs ?? Number(process.env.SMTP_CIRCUIT_OPEN_MS || 30_000));
  }

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
    // A top-up moves money from the bank's payment-clearing account to the customer, and its refund back:
    // only the customer's side is told (the clearing account belongs to nobody)
    const isTopUp = event.type === 'ONLINE_TOP_UP';
    const isTopUpRefund = event.type === 'TOP_UP_REFUND';
    // `side` is part of the delivery key: on a transfer between a customer's own accounts the same address
    // gets both the debit and the credit notice
    const parties: Array<{ email: string | null; direction: 'debited from' | 'credited to'; side: 'debit' | 'credit' }> = [];

    if (event.sourceAccountId && !isTopUp) {
      parties.push({
        email: await this.resolveAccountOwnerEmail(event.sourceAccountId, event.sourceCustomerId),
        direction: 'debited from',
        side: 'debit',
      });
    }
    if (event.destinationAccountId && !isTopUpRefund) {
      parties.push({
        email: await this.resolveAccountOwnerEmail(event.destinationAccountId, event.destinationCustomerId),
        direction: 'credited to',
        side: 'credit',
      });
    }

    const reference = `Transaction Reference: ${event.referenceId}\nTimestamp: ${event.timestamp}`;
    for (const party of parties) {
      if (!party.email) {
        this.contactMissing(event.eventId, event.timestamp);
        continue;
      }
      let subject = `BankSphere Alert: ${formattedAmount} ${party.direction} your account`;
      let body = `Dear Customer,\n\n${formattedAmount} has been ${party.direction} your account (${event.type}).\n\n${reference}\n\nIf you did not authorise this transaction, contact BankSphere immediately.\n\nThank you for banking with BankSphere.`;
      if (isTopUp) {
        subject = `BankSphere Alert: ${formattedAmount} credited to your account (online top-up)`;
        body = `Dear Customer,\n\n${formattedAmount} has been added to your account through an online top-up via Razorpay (${paymentMethodName(event.method)}).\n\n${reference}\n\nIf you did not make this payment, contact BankSphere immediately.\n\nThank you for banking with BankSphere.`;
      } else if (isTopUpRefund) {
        subject = `BankSphere Alert: ${formattedAmount} debited from your account (top-up refund)`;
        body = `Dear Customer,\n\n${formattedAmount} has been debited from your account to refund your online top-up. The money goes back to your original payment method (${refundDestination(event.method)}); we'll email you when the refund has been processed.\n\n${reference}\n\nIf you didn't expect this refund, contact BankSphere.\n\nThank you for banking with BankSphere.`;
      }
      await this.dispatchEmail(
        event.eventId,
        event.eventType,
        {
          recipient: party.email,
          subject,
          body,
          metadata: { transactionId: event.transactionId, referenceId: event.referenceId },
        },
        party.side
      );
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
      await this.dispatchEmail(event.eventId, event.eventType, {
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
      await this.dispatchEmail(event.eventId, event.eventType, {
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
      await this.dispatchEmail(event.eventId, event.eventType, {
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
   * A payee was added to the customer's online banking: a security notice, because adding a payee is the
   * first step of an account takeover (the cooling-off period gives the customer time to react).
   */
  public async handleBeneficiaryAdded(event: BeneficiaryAddedEvent): Promise<boolean> {
    const digits = typeof event.accountNumberLast4 === 'string' ? event.accountNumberLast4.replace(/\D/g, '') : '';
    const activatesAt = new Date(typeof event.activatesAt === 'string' ? event.activatesAt : NaN);
    if (typeof event.customerId !== 'string' || !event.customerId || digits.length < 4 || Number.isNaN(activatesAt.getTime())) {
      throw new Error('Malformed beneficiary.added.v1 event'); // permanent: dead-lettered by the consumer
    }
    if (await this.isEventProcessed(event.eventId)) {
      return false;
    }

    const recipient = await this.resolveEmail(event.customerId);
    if (recipient) {
      const addedAt = new Date(event.timestamp ?? Date.now()).getTime();
      const activation =
        activatesAt.getTime() <= (Number.isNaN(addedAt) ? Date.now() : addedAt) + 60_000
          ? 'The payee is active immediately.'
          : `Payments to this payee are possible from ${formatUtc(activatesAt)}.`;
      const nickname = plainLabel(typeof event.nickname === 'string' ? event.nickname : '');
      await this.dispatchEmail(event.eventId, event.eventType, {
        recipient,
        subject: 'BankSphere security notice: a new payee was added',
        body: `Dear Customer,\n\nA new payee was added to your BankSphere online banking.\n\nPayee: ${nickname}\nAccount number: ••••${digits.slice(-4)}\n\n${activation}\n\nIf this wasn't you, freeze your account and contact the bank immediately.`,
        metadata: { beneficiaryId: event.beneficiaryId },
      });
    } else {
      this.contactMissing(event.eventId, event.timestamp);
    }
    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Top-up status changes (payment.updated.v1). Only two need an email of their own:
   * - REFUNDED: the money is on its way back to the customer's original payment method
   * - CREDIT_BLOCKED: the customer paid but the money couldn't be added to the account (closed or frozen
   *   account, amount mismatch); it will be refunded
   * CREDITED is NOT emailed: the ledger's transaction.completed.v1 (ONLINE_TOP_UP) already sends the money-in
   * email. Other states are visible in the app and need no email.
   */
  public async handlePaymentUpdated(event: PaymentUpdatedEvent): Promise<boolean> {
    if (event.status !== 'REFUNDED' && event.status !== 'CREDIT_BLOCKED') return false;
    if (
      typeof event.customerId !== 'string' ||
      !event.customerId ||
      typeof event.topUpId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(event.topUpId) ||
      !/^\d{1,18}$/.test(String(event.amountInPaise))
    ) {
      throw new Error('Malformed payment.updated.v1 event'); // permanent: dead-lettered by the consumer
    }
    if (await this.isEventProcessed(event.eventId)) {
      return false;
    }

    const recipient = await this.resolveEmail(event.customerId);
    if (recipient) {
      const amount = MoneyUtil.formatINR(String(event.amountInPaise));
      const reference = `Top-up reference: ${event.topUpId}`;
      const destination = refundDestination(event.method);
      const email: EmailDispatchOptions =
        event.status === 'REFUNDED'
          ? {
              recipient,
              subject: `BankSphere: ${amount} refunded to your original payment method`,
              body: `Dear Customer,\n\n${amount} from your online top-up has been refunded to your original payment method (${destination}).\n\nIt can take a few working days to show on your statement, depending on your bank or card issuer.\n\n${reference}\n\nIf you have questions about this refund, contact BankSphere.`,
              metadata: { topUpId: event.topUpId, status: event.status },
            }
          : {
              recipient,
              subject: `BankSphere: we couldn't add your ${amount} top-up to your account`,
              body: `Dear Customer,\n\nWe received your payment of ${amount}, but we couldn't add it to your BankSphere account${creditBlockedReason(event.failureReason)}.\n\nYou don't need to do anything: the full amount will be refunded to your original payment method (${destination}), and we'll email you when the refund has been processed.\n\n${reference}\n\nIf you have questions, contact BankSphere.`,
              metadata: { topUpId: event.topUpId, status: event.status },
            };
      await this.dispatchEmail(event.eventId, event.eventType, email);
    } else {
      this.contactMissing(event.eventId, event.timestamp);
    }
    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * A sign-in from a browser/OS family and network not seen in 90 days (security.new_device_login.v1).
   * The alert goes to the address ON FILE (the read model built from user.registered.v1), so an event can
   * never redirect a security alert; the event's own address (from auth-service, the only producer allowed
   * on the topic) is used only when none is on file yet, so a new customer's alert is not held back.
   * The device label is derived from the User-Agent, i.e. chosen by whoever signed in: it is reduced to a
   * plain label and anything that looks like a link or phone number is dropped.
   */
  public async handleNewDeviceLogin(event: NewDeviceLoginEvent): Promise<boolean> {
    const at = validDate(event.at) ?? validDate(event.timestamp);
    if (typeof event.userId !== 'string' || !event.userId || !at) {
      throw new Error('Malformed security.new_device_login.v1 event'); // permanent: dead-lettered by the consumer
    }
    if (await this.isEventProcessed(event.eventId)) {
      return false;
    }

    const onFile = await this.resolveEmail(event.userId);
    const fromEvent = typeof event.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(event.email) ? event.email : null;
    if (onFile && fromEvent && onFile.toLowerCase() !== fromEvent.toLowerCase()) {
      logger.warn({ eventId: event.eventId, userId: event.userId, alert: 'CONTACT_MISMATCH' }, 'New-device alert sent to the address on file, not the one in the event');
    }
    const recipient = onFile ?? fromEvent;
    if (recipient) {
      await this.dispatchEmail(event.eventId, event.eventType, {
        recipient,
        subject: 'New sign-in to BankSphere',
        body: `Hello,\n\nWe noticed a new sign-in to your BankSphere account from a device or network you haven't used recently.\n\nDevice: ${deviceLabelForEmail(event.deviceLabel)}\nApproximate network: ${networkForEmail(event.ipMasked)}\nTime: ${formatIst(at)}\n\nIf this was you, you don't need to do anything.\n\nIf this wasn't you, act now: open Security in BankSphere and choose "Sign out everywhere else" to sign out every other device, then change your password. If you see payments you don't recognise, contact the bank immediately.\n\nBankSphere will never ask you for your password, OTP or PIN.`,
        metadata: { userId: event.userId, kind: 'NEW_DEVICE_LOGIN' },
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

    await this.dispatchEmail(event.eventId, event.eventType, emailOptions);
    await this.markEventProcessed(event.eventId, event.eventType);
    return true;
  }

  /**
   * Sends one email for (event, recipient[, purpose]) at most once across retries, redeliveries and
   * concurrent consumers. One SMTP attempt per Kafka try: the consumer's in-place retries and delayed-retry
   * topic do the retrying (with heartbeats), so a slow or dead mail server can't hold a partition.
   * - the delivery is CLAIMED (unique row) before sending, so a redelivered message never sends it again
   * - sent -> SENT log
   * - mail infrastructure failure (down, DNS/TLS/auth/protocol, 4xx) -> claim released and TransientError:
   *   the Kafka message is retried later and the event is NOT marked processed. While the SMTP circuit is
   *   open nothing is attempted at all.
   * - permanent rejection of this message (bad recipient, 5xx on RCPT/DATA) -> DEAD_LETTER log + notifications.dlq
   * `purpose` tells several emails of one event to the same address apart (e.g. the debit and credit notices).
   */
  public async dispatchEmail(
    eventId: string,
    eventType: string,
    options: EmailDispatchOptions,
    purpose?: string
  ): Promise<DispatchOutcome> {
    const deliveryKey = purpose ? `${eventId}:${purpose}` : eventId;
    if (!this.smtpCircuit.tryAcquire()) {
      // The mail server is known to be down: don't spend a connection timeout on every message
      throw new TransientError('SMTP circuit open: email not attempted');
    }

    try {
      try {
        await this.prisma.notificationDelivery.create({ data: { eventId: deliveryKey, recipient: options.recipient } });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        logger.info({ eventId, eventType, purpose }, 'Notification already sent (or settled) for this recipient; not resending');
        return 'ALREADY_SENT';
      }

      try {
        await this.emailProvider.sendEmail(options);
      } catch (err: any) {
        if (isTransientError(err)) {
          this.smtpCircuit.failed();
          await this.releaseClaim(eventId, deliveryKey, options.recipient);
          logger.warn({ eventId, eventType, err: redactErrorForLog(err) }, 'Email not sent: mail infrastructure unavailable; will retry');
          // The mail server (not the message) is the problem: let Kafka retry later, never dead-letter
          throw new TransientError(`Email provider unavailable: ${redactEmails(String(err?.message ?? err))}`);
        }
        this.smtpCircuit.succeeded(); // the server is up: it rejected this particular message
        await this.deadLetter(eventId, eventType, options, err);
        return 'DEAD_LETTER';
      }

      this.smtpCircuit.succeeded();
      try {
        await this.prisma.notificationLog.create({
          data: {
            recipient: options.recipient,
            channel: NotificationChannel.EMAIL,
            subject: options.subject,
            body: options.body,
            status: NotificationStatus.SENT,
            retryCount: 0,
            metadata: options.metadata,
          },
        });
      } catch (err) {
        // The email went out and its delivery is claimed: a missing audit row must never trigger a resend
        logger.error(
          { eventId, eventType, err: redactErrorForLog(err), alert: 'NOTIFICATION_LOG_WRITE_FAILED' },
          'Email sent but its audit log row could not be written'
        );
      }
      return 'SENT';
    } finally {
      this.smtpCircuit.release();
    }
  }

  /** Frees a delivery claim after a transient failure so a later try can send the email */
  private async releaseClaim(eventId: string, deliveryKey: string, recipient: string): Promise<void> {
    try {
      await this.prisma.notificationDelivery.deleteMany({ where: { eventId: deliveryKey, recipient } });
    } catch (err) {
      logger.error(
        { eventId, deliveryKey, err: redactErrorForLog(err), alert: 'NOTIFICATION_CLAIM_STUCK' },
        'Could not release a delivery claim; the email is not retried until its notification_deliveries row is removed'
      );
    }
  }

  /**
   * Records a permanently rejected email. The recipient stays in notification_logs (the staff-only audit
   * table); error text and the notifications.dlq payload carry no address: the DLQ references the log row.
   */
  private async deadLetter(eventId: string, eventType: string, options: EmailDispatchOptions, err: unknown): Promise<void> {
    const reason = redactEmails(String((err as any)?.message || 'Email delivery failure')).slice(0, 1000);
    logger.error({ eventId, eventType, err: redactErrorForLog(err) }, 'Permanent notification failure. Routing to Dead-Letter Queue.');

    const log = await this.prisma.notificationLog.create({
      data: {
        recipient: options.recipient,
        channel: NotificationChannel.EMAIL,
        subject: options.subject,
        body: options.body,
        status: NotificationStatus.DEAD_LETTER,
        retryCount: 0,
        lastError: reason,
        metadata: options.metadata,
      },
    });

    if (this.dlqPublisher) {
      try {
        await this.dlqPublisher.publish(this.dlqTopic, eventId, {
          originalEventId: eventId,
          originalEventType: eventType,
          notificationLogId: log?.id,
          failureReason: reason,
          recipientDomain: emailDomain(options.recipient),
          subject: options.subject,
          failedAt: new Date().toISOString(),
        });
      } catch (dlqErr) {
        logger.error({ err: redactErrorForLog(dlqErr), eventId }, 'Failed to publish message to DLQ topic');
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
