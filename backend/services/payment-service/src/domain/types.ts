import { PaymentStatus } from './status';

/** A top-up as stored (one row of payment_orders). Money is BigInt paise everywhere in code. */
export interface TopUp {
  id: string;
  customerId: string;
  accountId: string;
  accountNumberLast4: string;
  amountPaise: bigint;
  currency: string;
  status: PaymentStatus;
  version: number;
  idempotencyKey: string;
  requestHash: string;
  method: string | null;
  providerOrderId: string;
  providerPaymentId: string | null;
  capturedAmountPaise: bigint | null;
  capturedCurrency: string | null;
  failureReason: string | null;
  ledgerTransactionId: string | null;
  refundId: string | null;
  refundReason: string | null;
  refundRequestedBy: string | null;
  refundRequestKey: string | null;
  refundRequestedAt: Date | null;
  refundLedgerTransactionId: string | null;
  providerRefundId: string | null;
  refundFailureReason: string | null;
  expiresAt: Date;
  capturedAt: Date | null;
  creditedAt: Date | null;
  refundedAt: Date | null;
  reconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a transition (or a guarded update) may set; identity, money and ownership never change */
export type TopUpPatch = Partial<
  Pick<
    TopUp,
    | 'method'
    | 'providerPaymentId'
    | 'capturedAmountPaise'
    | 'capturedCurrency'
    | 'failureReason'
    | 'ledgerTransactionId'
    | 'refundId'
    | 'refundReason'
    | 'refundRequestedBy'
    | 'refundRequestKey'
    | 'refundRequestedAt'
    | 'refundLedgerTransactionId'
    | 'providerRefundId'
    | 'refundFailureReason'
    | 'capturedAt'
    | 'creditedAt'
    | 'refundedAt'
  >
>;

export type NewTopUp = Pick<
  TopUp,
  | 'id'
  | 'customerId'
  | 'accountId'
  | 'accountNumberLast4'
  | 'amountPaise'
  | 'currency'
  | 'idempotencyKey'
  | 'requestHash'
  | 'providerOrderId'
  | 'expiresAt'
>;

/** Who moved a top-up: shown in its history and in the ops timeline */
export type TransitionSource = 'customer' | 'confirm' | 'webhook' | 'reconciler' | 'admin' | 'system';

export interface HistoryEntry {
  from: PaymentStatus | null;
  to: PaymentStatus;
  source: string;
  reason: string | null;
  at: Date;
}

export interface AuditEntry {
  actorId: string;
  action: string;
  targetId?: string | null;
  /** Plain JSON (strings, numbers, booleans); BigInt must already be a decimal string */
  details?: Record<string, unknown>;
}

export interface PageRequest {
  limit: number;
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface StaffFilter {
  status?: PaymentStatus;
  customerId?: string;
  createdFrom?: Date;
  createdBefore?: Date;
}

export interface StatusTotals {
  status: PaymentStatus;
  count: number;
  amountPaise: bigint;
}

export interface SummaryData {
  byStatus: StatusTotals[];
  medianSecondsToCredit: number | null;
}
