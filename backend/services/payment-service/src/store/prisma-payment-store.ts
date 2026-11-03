import crypto from 'crypto';
import {
  ChainVerification,
  INSTANCE_ID,
  acquireJobLease,
  auditHash,
  lockAuditChain,
  verifyAuditChain,
} from '@banksphere/common';
import { Prisma, PrismaClient, PaymentOrder } from '../../generated/client';
import { OPEN_STATUSES, PaymentStatus, assertTransition, sourcesOf } from '../domain/status';
import { decodeCursor, encodeCursor } from '../domain/view';
import { PaymentErrors } from '../errors';
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
} from '../domain/types';
import {
  CreateLimits,
  InsertResult,
  PaymentStore,
  ReconcileQueue,
  TransitionRequest,
  WebhookClaim,
  WebhookClaimResult,
} from './payment-store';

type Tx = Prisma.TransactionClient;

export const PAYMENT_UPDATED_EVENT = 'payment.updated.v1';

/** Compile-time proof that a payment_orders row is exactly a TopUp */
const toTopUp = (row: PaymentOrder): TopUp => row;

/** The payment.updated.v1 outbox row for a status change (key = customer id, so a customer's events stay ordered) */
export function paymentUpdatedEvent(topUp: TopUp, previousStatus: PaymentStatus | null, correlationId?: string) {
  return {
    aggregateType: 'TOP_UP',
    aggregateId: topUp.customerId,
    eventType: PAYMENT_UPDATED_EVENT,
    status: 'PENDING' as const,
    payload: {
      eventId: crypto.randomUUID(),
      eventType: PAYMENT_UPDATED_EVENT,
      timestamp: new Date().toISOString(),
      ...(correlationId ? { correlationId } : {}),
      topUpId: topUp.id,
      customerId: topUp.customerId,
      accountId: topUp.accountId,
      amountInPaise: topUp.amountPaise.toString(),
      status: topUp.status,
      previousStatus,
      ...(topUp.method ? { method: topUp.method } : {}),
      ...(topUp.failureReason ? { failureReason: topUp.failureReason } : {}),
    },
  };
}

/** Appends one record to the hash chain; call inside the transaction that makes the change it records */
export async function appendAuditRecord(tx: Tx, entry: AuditEntry): Promise<void> {
  const prevHash = await lockAuditChain(tx);
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const record = auditRecord({ id, actorId: entry.actorId, action: entry.action, targetId: entry.targetId ?? null, details: entry.details ?? null, createdAt });
  await tx.auditLog.create({
    data: {
      id,
      actorId: entry.actorId,
      action: entry.action,
      targetId: entry.targetId ?? null,
      details: (entry.details ?? Prisma.DbNull) as Prisma.InputJsonValue,
      createdAt,
      prevHash,
      hash: auditHash(prevHash, record),
    },
  });
}

/** Exactly the fields that are hashed, when writing and when verifying */
function auditRecord(row: { id: string; actorId: string; action: string; targetId: string | null; details: unknown; createdAt: Date }) {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetId: row.targetId,
    details: row.details ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Today's committed volume: unexpired open orders plus captured or credited ones, created since dayStart */
function usedTodayWhere(customerId: string, dayStart: Date, now: Date): Prisma.PaymentOrderWhereInput {
  return {
    customerId,
    createdAt: { gte: dayStart },
    OR: [{ status: { in: ['CAPTURED', 'CREDITED'] } }, { status: { in: [...OPEN_STATUSES] }, expiresAt: { gt: now } }],
  };
}

function keyset(cursor: string | null | undefined): Prisma.PaymentOrderWhereInput {
  if (!cursor) return {};
  const position = decodeCursor(cursor);
  if (!position) throw PaymentErrors.invalidCursor();
  return { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }] };
}

export class PrismaPaymentStore implements PaymentStore {
  constructor(private readonly prisma: PrismaClient) {}

  public async findById(id: string): Promise<TopUp | null> {
    return this.prisma.paymentOrder.findUnique({ where: { id } });
  }

  public async findByIdempotencyKey(customerId: string, key: string): Promise<TopUp | null> {
    return this.prisma.paymentOrder.findUnique({ where: { customerId_idempotencyKey: { customerId, idempotencyKey: key } } });
  }

  public async findByProviderOrderId(orderId: string): Promise<TopUp | null> {
    return this.prisma.paymentOrder.findUnique({ where: { providerOrderId: orderId } });
  }

  public async findByRefund(ref: { providerRefundId?: string; refundId?: string }): Promise<TopUp | null> {
    if (ref.providerRefundId) {
      const byProvider = await this.prisma.paymentOrder.findUnique({ where: { providerRefundId: ref.providerRefundId } });
      if (byProvider) return byProvider;
    }
    return ref.refundId ? this.prisma.paymentOrder.findUnique({ where: { refundId: ref.refundId } }) : null;
  }

  public async history(topUpId: string): Promise<HistoryEntry[]> {
    const rows = await this.prisma.paymentStatusHistory.findMany({ where: { topUpId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => ({ from: r.fromStatus, to: r.toStatus, source: r.source, reason: r.reason, at: r.createdAt }));
  }

  public async usedToday(customerId: string, dayStart: Date, now: Date, client: Tx | PrismaClient = this.prisma): Promise<bigint> {
    const result = await client.paymentOrder.aggregate({ _sum: { amountPaise: true }, where: usedTodayWhere(customerId, dayStart, now) });
    return result._sum.amountPaise ?? 0n;
  }

  public async insertTopUp(input: NewTopUp, limits: CreateLimits, meta: { correlationId?: string } = {}): Promise<InsertResult> {
    return this.prisma.$transaction(async (tx) => {
      // Serialises this customer's creates, so the limits below can't be raced past by parallel requests
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payments:customer:${input.customerId}`}, 0))::text`;
      const open = await tx.paymentOrder.count({
        where: { customerId: input.customerId, status: { in: [...OPEN_STATUSES] }, expiresAt: { gt: limits.now } },
      });
      if (open >= limits.maxOpenOrders) return { ok: false, reason: 'TOO_MANY_OPEN' } as const;
      const used = await this.usedToday(input.customerId, limits.dayStart, limits.now, tx);
      if (used + input.amountPaise > limits.dailyLimitPaise) return { ok: false, reason: 'DAILY_LIMIT', usedPaise: used } as const;

      const row = toTopUp(await tx.paymentOrder.create({ data: { ...input, status: 'CREATED', version: 0 } }));
      await tx.paymentStatusHistory.create({
        data: { topUpId: row.id, fromStatus: null, toStatus: 'CREATED', source: 'customer', actorId: input.customerId },
      });
      await tx.outboxEvent.create({ data: paymentUpdatedEvent(row, null, meta.correlationId) });
      return { ok: true, topUp: row } as const;
    });
  }

  public async transition(request: TransitionRequest): Promise<TopUp | null> {
    const { topUp, to } = request;
    assertTransition(topUp.status, to); // an edge that isn't in the table is a bug, never a silent no-op
    return this.prisma.$transaction(async (tx) => {
      // Compare-and-set: UPDATE ... WHERE id = $1 AND status = ANY($sourcesOf(to)) AND version = $v
      const { count } = await tx.paymentOrder.updateMany({
        where: { id: topUp.id, status: { in: sourcesOf(to) }, version: topUp.version },
        data: { ...request.data, status: to, version: { increment: 1 } },
      });
      if (count !== 1) return null;
      const row = toTopUp(await tx.paymentOrder.findUniqueOrThrow({ where: { id: topUp.id } }));
      await tx.paymentStatusHistory.create({
        data: {
          topUpId: topUp.id,
          fromStatus: topUp.status,
          toStatus: to,
          source: request.source,
          actorId: request.actorId ?? null,
          reason: request.reason?.slice(0, 500) ?? null,
        },
      });
      await tx.outboxEvent.create({ data: paymentUpdatedEvent(row, topUp.status, request.correlationId) });
      if (request.audit) await appendAuditRecord(tx, request.audit);
      return row;
    });
  }

  public async update(topUp: TopUp, data: TopUpPatch): Promise<TopUp | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentOrder.updateMany({
        where: { id: topUp.id, status: topUp.status, version: topUp.version },
        data: { ...data, version: { increment: 1 } },
      });
      return count === 1 ? toTopUp(await tx.paymentOrder.findUniqueOrThrow({ where: { id: topUp.id } })) : null;
    });
  }

  public async markReconciled(id: string, at: Date): Promise<void> {
    // Raw on purpose: bookkeeping must not bump version or updated_at
    await this.prisma.$executeRaw`UPDATE payment_orders SET reconciled_at = ${at} WHERE id = ${id}`;
  }

  public async appendAudit(entry: AuditEntry): Promise<void> {
    await this.prisma.$transaction((tx) => appendAuditRecord(tx, entry));
  }

  public async verifyAudit(): Promise<ChainVerification> {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
    return verifyAuditChain(
      rows.map((r) => ({
        id: r.id,
        prevHash: r.prevHash,
        hash: r.hash,
        record: auditRecord({ id: r.id, actorId: r.actorId, action: r.action, targetId: r.targetId, details: r.details, createdAt: r.createdAt }),
      }))
    );
  }

  public async listByCustomer(customerId: string, page: PageRequest): Promise<Page<TopUp>> {
    return this.page({ customerId, ...keyset(page.cursor) }, page.limit);
  }

  public async listForStaff(filter: StaffFilter, page: PageRequest): Promise<Page<TopUp>> {
    const where: Prisma.PaymentOrderWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.createdFrom || filter.createdBefore
        ? { createdAt: { ...(filter.createdFrom ? { gte: filter.createdFrom } : {}), ...(filter.createdBefore ? { lt: filter.createdBefore } : {}) } }
        : {}),
    };
    return this.page({ AND: [where, keyset(page.cursor)] }, page.limit);
  }

  private async page(where: Prisma.PaymentOrderWhereInput, limit: number): Promise<Page<TopUp>> {
    const rows = await this.prisma.paymentOrder.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const items = rows.slice(0, limit).map(toTopUp);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
  }

  public async summarize(from: Date, to: Date): Promise<SummaryData> {
    const groups = await this.prisma.paymentOrder.groupBy({
      by: ['status'],
      where: { createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    const [median] = await this.prisma.$queryRaw<Array<{ median: number | null }>>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (credited_at - created_at)))::float8 AS median
      FROM payment_orders
      WHERE created_at >= ${from} AND created_at < ${to} AND credited_at IS NOT NULL
    `;
    return {
      byStatus: groups.map((g) => ({ status: g.status, count: g._count._all, amountPaise: g._sum.amountPaise ?? 0n })),
      medianSecondsToCredit: median?.median ?? null,
    };
  }

  public async dueForReconciliation(queue: ReconcileQueue, now: Date, limit: number): Promise<TopUp[]> {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    switch (queue) {
      case 'open': // waiting for payment for over 2 minutes: ask Razorpay, or expire after the TTL
        return this.prisma.paymentOrder.findMany({
          where: { status: { in: [...OPEN_STATUSES] }, createdAt: { lt: ago(2 * 60_000) } },
          orderBy: [{ reconciledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
          take: limit,
        });
      case 'captured': // captured but the ledger credit didn't complete
        return this.prisma.paymentOrder.findMany({
          where: { status: 'CAPTURED', updatedAt: { lt: ago(30_000) } },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        });
      case 'refund': // a refund saga that didn't finish synchronously
        return this.prisma.paymentOrder.findMany({
          where: { status: 'REFUND_PENDING', updatedAt: { lt: ago(60_000) } },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        });
      case 'late': {
        // Safety net for a missed webhook: ended orders of the last 48 h are re-checked for a late capture,
        // with the gap between checks doubling (about ten checks per order in total)
        const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM payment_orders
          WHERE status IN ('CANCELLED', 'FAILED', 'EXPIRED')
            AND created_at > ${ago(48 * 3600_000)}
            AND updated_at < ${ago(2 * 60_000)}
            AND (reconciled_at IS NULL OR reconciled_at < ${now}::timestamp - (reconciled_at - created_at))
          ORDER BY reconciled_at ASC NULLS FIRST, created_at ASC
          LIMIT ${limit}
        `;
        if (!ids.length) return [];
        return this.prisma.paymentOrder.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
      }
    }
  }

  public async claimWebhook(claim: WebhookClaim): Promise<WebhookClaimResult> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO webhook_events (id, event_type, payload_hash, status, attempts, received_at)
      VALUES (${claim.id}, ${claim.eventType}, ${claim.payloadHash}, 'RECEIVED', 1, now())
      ON CONFLICT (id) DO NOTHING
    `;
    if (inserted === 1) return { outcome: 'new' };
    const existing = await this.prisma.webhookEvent.findUnique({ where: { id: claim.id } });
    if (!existing) return { outcome: 'new' };
    if (existing.payloadHash !== claim.payloadHash) return { outcome: 'conflict' };
    if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') return { outcome: 'duplicate', status: existing.status };
    const updated = await this.prisma.webhookEvent.update({
      where: { id: claim.id },
      data: { attempts: { increment: 1 }, status: 'RECEIVED' },
    });
    return { outcome: 'retry', attempts: updated.attempts };
  }

  public async finishWebhook(id: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status, processedAt: status === 'FAILED' ? null : new Date(), lastError: error ? error.slice(0, 500) : null },
    });
  }

  public acquireLease(name: string, ttlSeconds: number): Promise<boolean> {
    return acquireJobLease(this.prisma, name, ttlSeconds);
  }

  public async releaseLease(name: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = ${name} AND holder = ${INSTANCE_ID}
    `;
  }

  public async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
