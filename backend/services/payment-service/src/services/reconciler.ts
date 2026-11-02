import { logger } from '@banksphere/common';
import { RazorpayApi } from '../clients/razorpay.client';
import { OPEN_STATUSES } from '../domain/status';
import { TopUp, TransitionSource } from '../domain/types';
import { PaymentErrors } from '../errors';
import { reconcilerActions, reconcilerRuns } from '../metrics';
import { PaymentStore, ReconcileQueue } from '../store/payment-store';
import { RefundService } from './refund.service';
import { SettlementService } from './settlement.service';
import { MAX_CAS_ATTEMPTS, StateWriter } from './state-writer';

export const RECONCILER_LEASE = 'payment-reconciler';

export interface ReconcileReport {
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  durationMs: number;
  checked: Record<ReconcileQueue, number>;
  /** Status changes made, by the status entered (e.g. CREDITED: 2, EXPIRED: 5) */
  changes: Record<string, number>;
  errors: number;
  /** true when the time budget ran out before every queue was drained (the next run continues) */
  truncated: boolean;
}

export interface ReconcilerOptions {
  batchSize?: number;
  /** Stop starting new work after this long (well inside the lease) */
  budgetMs?: number;
  leaseSeconds?: number;
}

/**
 * The safety net behind confirm and webhooks (every 60 s on one replica, under a job lease):
 *   open orders (CREATED/PENDING) older than 2 minutes: ask Razorpay; capture authorized, settle captured,
 *     mark failed; expire after TOPUP_ORDER_TTL_MINUTES
 *   CAPTURED but not credited: retry the (idempotent) ledger credit
 *   REFUND_PENDING: resume the refund saga (check the refund, finish or compensate)
 *   recently ended orders (CANCELLED/FAILED/EXPIRED): look for a late capture a missed webhook would have told us about
 */
export class Reconciler {
  private busy = false;
  private readonly batchSize: number;
  private readonly budgetMs: number;
  private readonly leaseSeconds: number;

  constructor(
    private readonly store: PaymentStore,
    private readonly writer: StateWriter,
    private readonly settlement: SettlementService,
    private readonly refunds: RefundService,
    private readonly razorpay: RazorpayApi,
    private readonly now: () => Date = () => new Date(),
    options: ReconcilerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.budgetMs = options.budgetMs ?? 45_000;
    this.leaseSeconds = options.leaseSeconds ?? 300;
  }

  /** The periodic run: does nothing (null) unless this replica takes the lease */
  public async runScheduled(): Promise<ReconcileReport | null> {
    if (!this.claim()) return null;
    return this.leased('scheduled', null, () => {
      reconcilerRuns.inc({ result: 'skipped' });
      return null;
    });
  }

  /** POST /admin/reconcile: runs now, unless a run is already in progress anywhere (409) */
  public async runNow(actorId: string): Promise<ReconcileReport> {
    if (!this.claim()) throw PaymentErrors.reconcileInProgress();
    return this.leased('manual', actorId, () => {
      throw PaymentErrors.reconcileInProgress();
    });
  }

  /**
   * Takes this replica's run slot synchronously, before anything awaits: the job lease is re-entrant for its
   * holder, so it alone would let two runs started together on one replica both proceed.
   */
  private claim(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  private async leased<T>(trigger: ReconcileReport['trigger'], actorId: string | null, refused: () => T): Promise<ReconcileReport | T> {
    try {
      if (!(await this.store.acquireLease(RECONCILER_LEASE, this.leaseSeconds))) return refused();
      try {
        return await this.run(trigger, actorId);
      } finally {
        await this.store.releaseLease(RECONCILER_LEASE).catch((err) => logger.warn({ err }, 'Could not release the reconciler lease'));
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(trigger: ReconcileReport['trigger'], actorId: string | null): Promise<ReconcileReport> {
    const started = this.now();
    const deadline = Date.now() + this.budgetMs;
    const report: ReconcileReport = {
      trigger,
      startedAt: started.toISOString(),
      durationMs: 0,
      checked: { open: 0, captured: 0, refund: 0, late: 0 },
      changes: {},
      errors: 0,
      truncated: false,
    };
    const source: TransitionSource = 'reconciler';
    const ctx = { source, actorId };

    try {
      for (const queue of ['open', 'captured', 'refund', 'late'] as const) {
        const due = await this.store.dueForReconciliation(queue, this.now(), this.batchSize);
        for (const topUp of due) {
          if (Date.now() >= deadline) {
            report.truncated = true;
            break;
          }
          report.checked[queue] += 1;
          try {
            const after = await this.reconcileOne(queue, topUp, ctx);
            if (after.status !== topUp.status) {
              report.changes[after.status] = (report.changes[after.status] ?? 0) + 1;
              reconcilerActions.inc({ action: after.status.toLowerCase() });
            }
          } catch (error) {
            report.errors += 1;
            logger.warn({ topUpId: topUp.id, queue, err: (error as Error).message }, 'Reconciling a top-up failed; will retry next run');
          }
        }
        if (report.truncated) break;
      }
      reconcilerRuns.inc({ result: report.errors ? 'partial' : 'ok' });
    } catch (error) {
      reconcilerRuns.inc({ result: 'error' });
      logger.error({ alert: 'PAYMENT_RECONCILIATION_ERROR', err: error }, 'Payment reconciliation run failed');
      throw error;
    } finally {
      report.durationMs = Date.now() - started.getTime();
    }

    const changed = Object.values(report.changes).reduce((a, b) => a + b, 0);
    logger.info({ report }, 'Payment reconciliation finished');
    // Manual runs are always audited; scheduled ones when they changed something
    if (trigger === 'manual' || changed > 0) {
      await this.store
        .appendAudit({
          actorId: actorId ?? 'system:reconciler',
          action: 'PAYMENT_RECONCILE_RUN',
          details: { trigger, checked: report.checked, changes: report.changes, errors: report.errors, truncated: report.truncated },
        })
        .catch((err) => logger.error({ err, alert: 'PAYMENT_AUDIT_WRITE_FAILED' }, 'Could not audit the reconciliation run'));
    }
    return report;
  }

  private async reconcileOne(queue: ReconcileQueue, topUp: TopUp, ctx: { source: TransitionSource; actorId: string | null }): Promise<TopUp> {
    switch (queue) {
      case 'open': {
        const payments = await this.razorpay.fetchOrderPayments(topUp.providerOrderId);
        await this.store.markReconciled(topUp.id, this.now());
        const after = await this.settlement.syncOrder(topUp, ctx, payments);
        // Nothing paid within the TTL: expire (a capture that still arrives later credits all the same)
        if (OPEN_STATUSES.includes(after.status) && after.expiresAt.getTime() <= this.now().getTime()) {
          return this.expire(after, ctx);
        }
        return after;
      }
      case 'captured':
        return this.settlement.creditIfDue(topUp, ctx);
      case 'refund':
        return (await this.refunds.advance(topUp, ctx)).topUp;
      case 'late': {
        const payments = await this.razorpay.fetchOrderPayments(topUp.providerOrderId);
        await this.store.markReconciled(topUp.id, this.now());
        const paid = payments.filter((p) => p.order_id === topUp.providerOrderId && (p.status === 'captured' || p.status === 'authorized'));
        return paid.length ? this.settlement.syncOrder(topUp, ctx, paid) : topUp;
      }
    }
  }

  private async expire(start: TopUp, ctx: { source: TransitionSource; actorId: string | null }): Promise<TopUp> {
    let topUp = start;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && OPEN_STATUSES.includes(topUp.status); attempt++) {
      const expired = await this.writer.move({
        topUp,
        to: 'EXPIRED',
        source: ctx.source,
        actorId: ctx.actorId,
        reason: 'ORDER_EXPIRED',
        data: { failureReason: 'ORDER_EXPIRED' },
      });
      if (expired) return expired;
      topUp = await this.writer.reload(topUp.id);
    }
    return topUp;
  }
}
