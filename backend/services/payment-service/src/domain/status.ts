/**
 * The top-up state machine (platform design, section 6), as a CLOSED table: a transition that is not listed
 * here cannot happen. Every write is a compare-and-set on (status, version) whose status guard is
 * `sourcesOf(target)`, so even a stale or buggy caller can't move a top-up along an edge that isn't drawn.
 *
 *   CREATED ─▶ PENDING ─▶ CAPTURED ─▶ CREDITED ─▶ REFUND_PENDING ─▶ REFUNDED
 *      │          │           │           ▲             ├──────────▶ CREDITED       (refund failed, compensated)
 *      │          ▼           │           └─────────────┤
 *      │                      └─▶ CREDIT_BLOCKED ───────┴──────────▶ CREDIT_BLOCKED (refund failed, nothing debited)
 *      ├─▶ CANCELLED  (customer closed checkout)
 *      ├─▶ FAILED     (payment failed)
 *      └─▶ EXPIRED    (no payment within TOPUP_ORDER_TTL_MINUTES)
 *   CANCELLED / FAILED / EXPIRED ─▶ CAPTURED   (a late capture still credits: the customer's money was taken)
 */
export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'CAPTURED',
  'CREDITED',
  'CREDIT_BLOCKED',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = Object.freeze({
  CREATED: ['PENDING', 'CAPTURED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  PENDING: ['CAPTURED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  CAPTURED: ['CREDITED', 'CREDIT_BLOCKED'],
  CREDITED: ['REFUND_PENDING'],
  CREDIT_BLOCKED: ['REFUND_PENDING'],
  // Back to where the refund started when it fails: CREDITED after the ledger debit is reversed, or
  // CREDIT_BLOCKED (never credited, so nothing was debited)
  REFUND_PENDING: ['REFUNDED', 'CREDITED', 'CREDIT_BLOCKED'],
  REFUNDED: [],
  CANCELLED: ['CAPTURED'],
  FAILED: ['CAPTURED'],
  EXPIRED: ['CAPTURED'],
});

/** Waiting for the customer to pay: they count towards the open-order and daily limits until they expire */
export const OPEN_STATUSES: readonly PaymentStatus[] = ['CREATED', 'PENDING'];
/** Ended without a payment; a capture that arrives later still credits */
export const LATE_CAPTURE_STATUSES: readonly PaymentStatus[] = ['CANCELLED', 'FAILED', 'EXPIRED'];
/** The bank has the customer's money for these (credited, or held for a refund) */
export const REFUNDABLE_STATUSES: readonly PaymentStatus[] = ['CREDITED', 'CREDIT_BLOCKED'];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every status `to` may be reached from: the `status = ANY(...)` guard of the conditional UPDATE */
export function sourcesOf(to: PaymentStatus): PaymentStatus[] {
  return PAYMENT_STATUSES.filter((from) => TRANSITIONS[from].includes(to));
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus
  ) {
    super(`Illegal top-up transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
