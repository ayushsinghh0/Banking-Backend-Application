/**
 * Payloads of the real-time events (platform design, section 8). Events are hints: the browser refetches
 * the truth from the APIs, so these carry identifiers and a little context, never whole records.
 */

/** Money moved on one of the customer's accounts (sent to both the source and destination customer) */
export interface TransactionPostedEvent {
  transactionId: string;
  type: string;
  amountInPaise: string;
  accountId: string;
  /** From this account's point of view: money in (CREDIT) or out (DEBIT) */
  direction: string;
}

/** A top-up changed state (the customer; staff with the BANK_ADMIN role) */
export interface PaymentUpdatedEvent {
  topUpId: string;
  status: string;
  amountInPaise: string;
  accountId: string;
}

/** A fraud rule raised an alert (FRAUD_ANALYST, BANK_ADMIN and SUPPORT) */
export interface FraudAlertRaisedEvent {
  alertId: string;
  severity: string;
  accountId: string;
}

export interface AccountStatusEvent {
  accountId: string;
  status: string;
}

export interface PayeeAddedEvent {
  beneficiaryId: string;
  nickname: string;
  activatesAt: string;
}

/** Whether an event's direction means money arrived (the service may say CREDIT or in) */
export const isMoneyIn = (direction: string | undefined) => /^(credit|in)$/i.test(direction ?? '');
