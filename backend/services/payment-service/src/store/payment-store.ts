import { ChainVerification } from '@banksphere/common';
import { PaymentStatus } from '../domain/status';
import {
  AuditEntry,
  HistoryEntry,
  NewTopUp,
  Page,
  PageRequest,
  StaffFilter,
  SummaryData,
  TopUp,
  TopUpPatch,
  TransitionSource,
} from '../domain/types';

export interface CreateLimits {
  maxOpenOrders: number;
  dailyLimitPaise: bigint;
  /** Start of the current IST day */
  dayStart: Date;
  now: Date;
}

export type InsertResult =
  | { ok: true; topUp: TopUp }
  | { ok: false; reason: 'TOO_MANY_OPEN' }
  | { ok: false; reason: 'DAILY_LIMIT'; usedPaise: bigint };

export interface TransitionRequest {
  /** The top-up as read: its id, status and version form the compare-and-set guard */
  topUp: TopUp;
  to: PaymentStatus;
  source: TransitionSource;
  actorId?: string | null;
  /** Why (history row); e.g. a failure code */
  reason?: string | null;
  /** Columns set in the same UPDATE */
  data?: TopUpPatch;
  /** Audit record written in the same transaction */
  audit?: AuditEntry;
  correlationId?: string;
}

export interface WebhookClaim {
  id: string;
  eventType: string;
  payloadHash: string;
}

export type WebhookClaimResult =
  | { outcome: 'new' }
  /** Seen before but never finished (an earlier attempt failed): process again */
  | { outcome: 'retry'; attempts: number }
  | { outcome: 'duplicate'; status: 'PROCESSED' | 'IGNORED' }
  /** Same event id with a different body: never applied */
  | { outcome: 'conflict' };

export type ReconcileQueue = 'open' | 'captured' | 'refund' | 'late';

/**
 * Persistence for top-ups. Every status change goes through `transition`, which is one database transaction:
 * a guarded UPDATE (id, status IN sourcesOf(to), version) + an append-only history row + a payment.updated.v1
 * outbox event (+ an optional chained audit record). It returns null when the guard fails, i.e. someone else
 * changed the top-up first; callers re-read and decide again.
 */
export interface PaymentStore {
  findById(id: string): Promise<TopUp | null>;
  findByIdempotencyKey(customerId: string, key: string): Promise<TopUp | null>;
  findByProviderOrderId(orderId: string): Promise<TopUp | null>;
  findByRefund(ref: { providerRefundId?: string; refundId?: string }): Promise<TopUp | null>;
  history(topUpId: string): Promise<HistoryEntry[]>;
  /** Today's (IST) committed top-up volume: CREATED/PENDING unexpired + CAPTURED + CREDITED */
  usedToday(customerId: string, dayStart: Date, now: Date): Promise<bigint>;

  /** Under a per-customer lock: re-checks the open-order and daily limits, then inserts as CREATED */
  insertTopUp(input: NewTopUp, limits: CreateLimits, meta?: { correlationId?: string }): Promise<InsertResult>;
  transition(request: TransitionRequest): Promise<TopUp | null>;
  /** Guarded non-status update (same compare-and-set on status and version) */
  update(topUp: TopUp, data: TopUpPatch): Promise<TopUp | null>;
  /** Bookkeeping only: when the reconciler last asked Razorpay about this order */
  markReconciled(id: string, at: Date): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  verifyAudit(): Promise<ChainVerification>;

  listByCustomer(customerId: string, page: PageRequest): Promise<Page<TopUp>>;
  listForStaff(filter: StaffFilter, page: PageRequest): Promise<Page<TopUp>>;
  summarize(from: Date, to: Date): Promise<SummaryData>;
  dueForReconciliation(queue: ReconcileQueue, now: Date, limit: number): Promise<TopUp[]>;

  claimWebhook(claim: WebhookClaim): Promise<WebhookClaimResult>;
  finishWebhook(id: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string): Promise<void>;

  acquireLease(name: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(name: string): Promise<void>;
  ping(): Promise<void>;
}
