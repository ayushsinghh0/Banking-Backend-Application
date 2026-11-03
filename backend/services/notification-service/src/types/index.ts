export interface BaseEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  correlationId?: string;
}

export interface TransactionCompletedEvent extends BaseEvent {
  eventType: 'transaction.completed.v1';
  transactionId: string;
  referenceId: string;
  /**
   * ONLINE_TOP_UP: payment clearing -> customer (money added with Razorpay).
   * TOP_UP_REFUND: customer -> payment clearing (a top-up refunded to the original payment method).
   */
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'ONLINE_TOP_UP' | 'TOP_UP_REFUND';
  amountInPaise: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
  sourceCustomerId?: string;
  destinationCustomerId?: string;
  /** Top-ups and refunds: the Razorpay method (upi, card, netbanking...), when the ledger was told */
  method?: string;
}

export type TopUpStatus =
  | 'CREATED'
  | 'PENDING'
  | 'CAPTURED'
  | 'CREDITED'
  | 'CREDIT_BLOCKED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED';

/** Produced by payment-service on every top-up state change */
export interface PaymentUpdatedEvent extends BaseEvent {
  eventType: 'payment.updated.v1';
  topUpId: string;
  customerId: string;
  accountId: string;
  amountInPaise: string;
  status: TopUpStatus;
  previousStatus?: TopUpStatus | null;
  /** Razorpay method: upi, card, netbanking, wallet ... */
  method?: string;
  /** Machine-readable reason (e.g. ACCOUNT_CLOSED); never shown to customers as is */
  failureReason?: string;
}

/** Produced by auth-service when a sign-in comes from a browser/OS family and network not seen in 90 days */
export interface NewDeviceLoginEvent extends BaseEvent {
  eventType: 'security.new_device_login.v1';
  userId: string;
  email: string;
  /** e.g. "Chrome on Windows" (derived from the User-Agent, so attacker-influenced) */
  deviceLabel: string;
  /** Network part only: "203.0.113.x", "2001:db8:1::/48" */
  ipMasked: string;
  /** ISO-8601 time of the sign-in */
  at: string;
}

export interface AccountCreatedEvent extends BaseEvent {
  eventType: 'account.created.v1';
  accountId: string;
  accountNumber: string;
  customerId: string;
  accountType: 'SAVINGS' | 'CURRENT';
  currency: string;
}

export interface AccountStatusChangedEvent extends BaseEvent {
  eventType: 'account.status.changed.v1';
  accountId: string;
  customerId: string;
  previousStatus: string;
  status: string;
}

export interface WithdrawalCodeCreatedEvent extends BaseEvent {
  eventType: 'withdrawal.code.created.v1';
  customerId: string;
  accountId: string;
  amountInPaise: string;
  expiresAt: string;
}

/** Produced by the ledger (transaction-service) when a customer registers a payee */
export interface BeneficiaryAddedEvent extends BaseEvent {
  eventType: 'beneficiary.added.v1';
  customerId: string;
  beneficiaryId: string;
  accountNumberLast4: string;
  nickname: string;
  /** When transfers to the payee become possible (cooling-off), ISO-8601 */
  activatesAt: string;
}

export interface UserRegisteredEvent extends BaseEvent {
  eventType: 'user.registered.v1';
  userId: string;
  email: string;
  role: string;
}

export interface FraudAlertCreatedEvent extends BaseEvent {
  eventType: 'fraud.alert.created.v1';
  alertId: string;
  transactionId: string;
  accountId: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
}

export interface EmailDispatchOptions {
  recipient: string;
  subject: string;
  body: string;
  metadata?: Record<string, any>;
}
