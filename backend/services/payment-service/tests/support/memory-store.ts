import crypto from 'crypto';
import { ChainVerification, GENESIS_HASH, auditHash, verifyAuditChain } from '@banksphere/common';
import { LATE_CAPTURE_STATUSES, OPEN_STATUSES, PaymentStatus, assertTransition, sourcesOf } from '../../src/domain/status';
import { decodeCursor, encodeCursor } from '../../src/domain/view';
import { AuditEntry, HistoryEntry, NewTopUp, Page, PageRequest, StaffFilter, SummaryData, TopUp, TopUpPatch } from '../../src/domain/types';
import { PaymentErrors } from '../../src/errors';
import {
  CreateLimits,
  InsertResult,
  PaymentStore,
  ReconcileQueue,
  TransitionRequest,
  WebhookClaim,
  WebhookClaimResult,
} from '../../src/store/payment-store';
import { paymentUpdatedEvent } from '../../src/store/prisma-payment-store';

/** Lets other pending promises run, like a database round trip would */
const io = () => new Promise<void>((resolve) => setImmediate(resolve));

interface AuditRow {
  id: string;
  seq: number;
  actorId: string;
  action: string;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
  prevHash: string;
  hash: string;
}

/**
 * In-memory PaymentStore with the same guarantees the SQL gives: each method's read-check-write runs without
 * interleaving (one "statement"), transitions are compare-and-set on (status in sourcesOf(to), version) and
 * write history + outbox + audit together, (customer, idempotency key) and provider ids are unique.
 */
export class MemoryStore implements PaymentStore {
  public readonly rows = new Map<string, TopUp>();
  public readonly historyRows: Array<HistoryEntry & { topUpId: string; actorId: string | null }> = [];
  public readonly outbox: Array<ReturnType<typeof paymentUpdatedEvent>> = [];
  public readonly audits: AuditRow[] = [];
  public readonly webhooks = new Map<string, { eventType: string; payloadHash: string; status: string; attempts: number; lastError: string | null }>();
  public lease: { holder: string; expiresAt: number } | null = null;
  public leaseOwner = 'me';
  public transitionCalls = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Test helper: put a top-up straight into a given state */
  public seed(topUp: TopUp): TopUp {
    this.rows.set(topUp.id, { ...topUp });
    return topUp;
  }

  public get(id: string): TopUp {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no top-up ${id}`);
    return row;
  }

  async findById(id: string) {
    await io();
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByIdempotencyKey(customerId: string, key: string) {
    await io();
    const row = [...this.rows.values()].find((r) => r.customerId === customerId && r.idempotencyKey === key);
    return row ? { ...row } : null;
  }

  async findByProviderOrderId(orderId: string) {
    await io();
    const row = [...this.rows.values()].find((r) => r.providerOrderId === orderId);
    return row ? { ...row } : null;
  }

  async findByRefund(ref: { providerRefundId?: string; refundId?: string }) {
    await io();
    const row =
      [...this.rows.values()].find((r) => ref.providerRefundId && r.providerRefundId === ref.providerRefundId) ??
      [...this.rows.values()].find((r) => ref.refundId && r.refundId === ref.refundId);
    return row ? { ...row } : null;
  }

  async history(topUpId: string) {
    await io();
    return this.historyRows.filter((h) => h.topUpId === topUpId).map(({ from, to, source, reason, at }) => ({ from, to, source, reason, at }));
  }

  private used(customerId: string, dayStart: Date, now: Date): bigint {
    let total = 0n;
    for (const r of this.rows.values()) {
      if (r.customerId !== customerId || r.createdAt < dayStart) continue;
      const counts =
        r.status === 'CAPTURED' || r.status === 'CREDITED' || (OPEN_STATUSES.includes(r.status) && r.expiresAt.getTime() > now.getTime());
      if (counts) total += r.amountPaise;
    }
    return total;
  }

  async usedToday(customerId: string, dayStart: Date, now: Date) {
    await io();
    return this.used(customerId, dayStart, now);
  }

  async insertTopUp(input: NewTopUp, limits: CreateLimits, meta: { correlationId?: string } = {}): Promise<InsertResult> {
    await io();
    if ([...this.rows.values()].some((r) => r.customerId === input.customerId && r.idempotencyKey === input.idempotencyKey)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const open = [...this.rows.values()].filter(
      (r) => r.customerId === input.customerId && OPEN_STATUSES.includes(r.status) && r.expiresAt.getTime() > limits.now.getTime()
    ).length;
    if (open >= limits.maxOpenOrders) return { ok: false, reason: 'TOO_MANY_OPEN' };
    const used = this.used(input.customerId, limits.dayStart, limits.now);
    if (used + input.amountPaise > limits.dailyLimitPaise) return { ok: false, reason: 'DAILY_LIMIT', usedPaise: used };
    const now = this.clock();
    const row: TopUp = {
      ...input,
      status: 'CREATED',
      version: 0,
      method: null,
      providerPaymentId: null,
      capturedAmountPaise: null,
      capturedCurrency: null,
      failureReason: null,
      ledgerTransactionId: null,
      refundId: null,
      refundReason: null,
      refundRequestedBy: null,
      refundRequestKey: null,
      refundRequestedAt: null,
      refundLedgerTransactionId: null,
      providerRefundId: null,
      refundFailureReason: null,
      capturedAt: null,
      creditedAt: null,
      refundedAt: null,
      reconciledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.historyRows.push({ topUpId: row.id, from: null, to: 'CREATED', source: 'customer', reason: null, at: now, actorId: input.customerId });
    this.outbox.push(paymentUpdatedEvent(row, null, meta.correlationId));
    return { ok: true, topUp: { ...row } };
  }

  private assertUnique(id: string, data: TopUpPatch) {
    for (const key of ['providerPaymentId', 'refundId', 'providerRefundId'] as const) {
      const value = data[key];
      if (value && [...this.rows.values()].some((r) => r.id !== id && r[key] === value)) {
        throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
      }
    }
  }

  async transition(request: TransitionRequest): Promise<TopUp | null> {
    assertTransition(request.topUp.status, request.to);
    this.transitionCalls += 1;
    await io();
    const row = this.rows.get(request.topUp.id);
    if (!row || !sourcesOf(request.to).includes(row.status) || row.version !== request.topUp.version) return null;
    this.assertUnique(row.id, request.data ?? {});
    const now = this.clock();
    const from = row.status;
    Object.assign(row, request.data ?? {}, { status: request.to, version: row.version + 1, updatedAt: now });
    this.historyRows.push({
      topUpId: row.id,
      from,
      to: request.to,
      source: request.source,
      reason: request.reason ?? null,
      at: now,
      actorId: request.actorId ?? null,
    });
    this.outbox.push(paymentUpdatedEvent(row, from, request.correlationId));
    if (request.audit) this.audit(request.audit);
    return { ...row };
  }

  async update(topUp: TopUp, data: TopUpPatch): Promise<TopUp | null> {
    await io();
    const row = this.rows.get(topUp.id);
    if (!row || row.status !== topUp.status || row.version !== topUp.version) return null;
    this.assertUnique(row.id, data);
    Object.assign(row, data, { version: row.version + 1, updatedAt: this.clock() });
    return { ...row };
  }

  async markReconciled(id: string, at: Date) {
    await io();
    const row = this.rows.get(id);
    if (row) row.reconciledAt = at;
  }

  private audit(entry: AuditEntry) {
    const prevHash = this.audits.length ? this.audits[this.audits.length - 1].hash : GENESIS_HASH;
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const details = entry.details ?? null;
    const record = { id, actorId: entry.actorId, action: entry.action, targetId: entry.targetId ?? null, details, createdAt: createdAt.toISOString() };
    this.audits.push({ id, seq: this.audits.length + 1, actorId: entry.actorId, action: entry.action, targetId: entry.targetId ?? null, details, createdAt, prevHash, hash: auditHash(prevHash, record) });
  }

  async appendAudit(entry: AuditEntry) {
    await io();
    this.audit(entry);
  }

  async verifyAudit(): Promise<ChainVerification> {
    return verifyAuditChain(
      this.audits.map((a) => ({
        id: a.id,
        prevHash: a.prevHash,
        hash: a.hash,
        record: { id: a.id, actorId: a.actorId, action: a.action, targetId: a.targetId, details: a.details, createdAt: a.createdAt.toISOString() },
      }))
    );
  }

  private page(rows: TopUp[], page: PageRequest): Page<TopUp> {
    let sorted = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    if (page.cursor) {
      const c = decodeCursor(page.cursor);
      if (!c) throw PaymentErrors.invalidCursor();
      sorted = sorted.filter((r) => r.createdAt < c.createdAt || (r.createdAt.getTime() === c.createdAt.getTime() && r.id < c.id));
    }
    const items = sorted.slice(0, page.limit).map((r) => ({ ...r }));
    return { items, nextCursor: sorted.length > page.limit ? encodeCursor(items[items.length - 1]) : null };
  }

  async listByCustomer(customerId: string, page: PageRequest) {
    await io();
    return this.page([...this.rows.values()].filter((r) => r.customerId === customerId), page);
  }

  async listForStaff(filter: StaffFilter, page: PageRequest) {
    await io();
    return this.page(
      [...this.rows.values()].filter(
        (r) =>
          (!filter.status || r.status === filter.status) &&
          (!filter.customerId || r.customerId === filter.customerId) &&
          (!filter.createdFrom || r.createdAt >= filter.createdFrom) &&
          (!filter.createdBefore || r.createdAt < filter.createdBefore)
      ),
      page
    );
  }

  async summarize(from: Date, to: Date): Promise<SummaryData> {
    await io();
    const rows = [...this.rows.values()].filter((r) => r.createdAt >= from && r.createdAt < to);
    const by = new Map<PaymentStatus, { count: number; amountPaise: bigint }>();
    for (const r of rows) {
      const t = by.get(r.status) ?? { count: 0, amountPaise: 0n };
      by.set(r.status, { count: t.count + 1, amountPaise: t.amountPaise + r.amountPaise });
    }
    const secs = rows
      .filter((r) => r.creditedAt)
      .map((r) => (r.creditedAt!.getTime() - r.createdAt.getTime()) / 1000)
      .sort((a, b) => a - b);
    const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
    return { byStatus: [...by.entries()].map(([status, t]) => ({ status, ...t })), medianSecondsToCredit: median };
  }

  async dueForReconciliation(queue: ReconcileQueue, now: Date, limit: number) {
    await io();
    const age = (d: Date) => now.getTime() - d.getTime();
    const rows = [...this.rows.values()].filter((r) => {
      switch (queue) {
        case 'open':
          return OPEN_STATUSES.includes(r.status) && age(r.createdAt) > 2 * 60_000;
        case 'captured':
          return r.status === 'CAPTURED' && age(r.updatedAt) > 30_000;
        case 'refund':
          return r.status === 'REFUND_PENDING' && age(r.updatedAt) > 60_000;
        case 'late':
          return (
            LATE_CAPTURE_STATUSES.includes(r.status) &&
            age(r.createdAt) < 48 * 3600_000 &&
            age(r.updatedAt) > 2 * 60_000 &&
            (!r.reconciledAt || age(r.reconciledAt) > r.reconciledAt.getTime() - r.createdAt.getTime())
          );
      }
    });
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }

  async claimWebhook(claim: WebhookClaim): Promise<WebhookClaimResult> {
    await io();
    const existing = this.webhooks.get(claim.id);
    if (!existing) {
      this.webhooks.set(claim.id, { eventType: claim.eventType, payloadHash: claim.payloadHash, status: 'RECEIVED', attempts: 1, lastError: null });
      return { outcome: 'new' };
    }
    if (existing.payloadHash !== claim.payloadHash) return { outcome: 'conflict' };
    if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') return { outcome: 'duplicate', status: existing.status };
    existing.attempts += 1;
    existing.status = 'RECEIVED';
    return { outcome: 'retry', attempts: existing.attempts };
  }

  async finishWebhook(id: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) {
    await io();
    const row = this.webhooks.get(id)!;
    row.status = status;
    row.lastError = error ?? null;
  }

  async acquireLease(_name: string, ttlSeconds: number) {
    await io();
    const now = Date.now();
    if (this.lease && this.lease.expiresAt > now && this.lease.holder !== this.leaseOwner) return false;
    this.lease = { holder: this.leaseOwner, expiresAt: now + ttlSeconds * 1000 };
    return true;
  }

  async releaseLease() {
    await io();
    if (this.lease?.holder === this.leaseOwner) this.lease = null;
  }

  async ping() {
    await io();
  }
}
