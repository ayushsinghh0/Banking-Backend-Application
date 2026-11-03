import crypto from 'crypto';
import { AuthenticatedUser, HttpError, hasRecentStrongAuth, logger } from '@banksphere/common';
import { RazorpayApi, RazorpayRefund, RazorpayRequestError } from '../clients/razorpay.client';
import { LedgerApi } from '../clients/ledger.client';
import { PaymentConfig } from '../config';
import { REFUNDABLE_STATUSES } from '../domain/status';
import { TopUp, TransitionSource } from '../domain/types';
import { PaymentErrors } from '../errors';
import { PaymentStore } from '../store/payment-store';
import { MAX_CAS_ATTEMPTS, StateWriter } from './state-writer';

export interface RefundContext {
  source: TransitionSource;
  actorId?: string | null;
  correlationId?: string;
  /** An administrator is waiting for the answer: refusals become errors they can act on */
  interactive?: boolean;
}

export interface RefundOutcome {
  topUp: TopUp;
  /** false while the refund is still in flight (Razorpay pending, or a dependency was unavailable) */
  settled: boolean;
}

const SYSTEM_ACTOR = 'system:payment-service';

/**
 * Bank-initiated refund of a top-up, as a saga (design section 6):
 *
 *   CREDITED|CREDIT_BLOCKED -> REFUND_PENDING (new refund id, audited)
 *   -> ledger debit, idempotent on the refund id (CREDITED only; a blocked credit was never posted)
 *   -> Razorpay refund (receipt and notes carry the refund id, so a retry finds an earlier attempt)
 *   -> REFUNDED when Razorpay processes it (synchronously, by the refund.processed webhook or the reconciler)
 *
 * Failure: the ledger refuses the debit (INSUFFICIENT_FUNDS) -> back to CREDITED, nothing moved. Razorpay
 * refuses or fails the refund -> the ledger debit is reversed (idempotent) and the top-up returns to CREDITED
 * (CREDIT_BLOCKED if it started there). A dependency that is down leaves REFUND_PENDING; every step can be
 * re-run, so `advance` simply resumes from where the saga stopped.
 */
export class RefundService {
  constructor(
    private readonly store: PaymentStore,
    private readonly writer: StateWriter,
    private readonly razorpay: RazorpayApi,
    private readonly ledger: LedgerApi,
    private readonly config: PaymentConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async refund(
    admin: AuthenticatedUser,
    topUpId: string,
    reason: string,
    idempotencyKey: string | undefined,
    correlationId?: string
  ): Promise<RefundOutcome> {
    if (!hasRecentStrongAuth(admin, { maxAgeSeconds: this.config.stepUp.maxAgeSeconds, minFactorAgeSeconds: this.config.stepUp.minFactorAgeSeconds })) {
      logger.warn({ userId: admin.id, topUpId, alert: 'REFUND_STEP_UP_MISSING' }, 'Refund refused: no recent step-up');
      throw PaymentErrors.stepUpRequired();
    }
    let topUp = await this.store.findById(topUpId);
    if (!topUp) throw PaymentErrors.topUpNotFound();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      // A retry of the same request (same Idempotency-Key) answers with the refund it started
      if (idempotencyKey && topUp.refundRequestKey === idempotencyKey && topUp.refundRequestedBy === admin.id) {
        return { topUp, settled: topUp.status !== 'REFUND_PENDING' };
      }
      if (!REFUNDABLE_STATUSES.includes(topUp.status)) throw PaymentErrors.notRefundable();
      const refundId = crypto.randomUUID();
      const pending = await this.writer.move({
        topUp,
        to: 'REFUND_PENDING',
        source: 'admin',
        actorId: admin.id,
        reason: 'REFUND_REQUESTED',
        correlationId,
        data: {
          refundId,
          refundReason: reason,
          refundRequestedBy: admin.id,
          refundRequestKey: idempotencyKey ?? null,
          refundRequestedAt: this.now(),
          refundLedgerTransactionId: null,
          providerRefundId: null,
          refundFailureReason: null,
          refundedAt: null,
        },
        audit: {
          actorId: admin.id,
          action: 'PAYMENT_REFUND_REQUESTED',
          targetId: topUp.id,
          details: {
            refundId,
            reason,
            fromStatus: topUp.status,
            amountPaise: topUp.amountPaise.toString(),
            refundAmountPaise: refundAmount(topUp).toString(),
            customerId: topUp.customerId,
            accountId: topUp.accountId,
            ledgerDebit: topUp.status === 'CREDITED',
          },
        },
      });
      if (pending) return this.advance(pending, { source: 'admin', actorId: admin.id, correlationId, interactive: true });
      topUp = await this.writer.reload(topUpId);
    }
    throw PaymentErrors.notRefundable();
  }

  /** Runs the saga forward from wherever it stopped (admin request, webhook, reconciler) */
  public async advance(start: TopUp, ctx: RefundContext): Promise<RefundOutcome> {
    let topUp = start;
    for (let step = 0; step < MAX_CAS_ATTEMPTS * 2; step++) {
      if (topUp.status !== 'REFUND_PENDING') return { topUp, settled: true };
      if (topUp.refundFailureReason) return this.compensate(topUp, ctx);

      // 1. Ledger debit (only a credited top-up has money in the customer's account to take back)
      if (topUp.ledgerTransactionId && !topUp.refundLedgerTransactionId) {
        let posting;
        try {
          posting = await this.ledger.debitRefund({
            refundId: topUp.refundId!,
            topUpId: topUp.id,
            accountId: topUp.accountId,
            customerId: topUp.customerId,
            amountPaise: topUp.amountPaise,
          });
        } catch (error) {
          if (error instanceof HttpError && error.statusCode >= 400 && error.statusCode < 500) {
            return this.ledgerRefused(topUp, error, ctx);
          }
          logger.error({ alert: 'PAYMENT_REFUND_STALLED', topUpId: topUp.id, stage: 'ledger', err: (error as Error).message }, 'Refund debit did not complete; will resume');
          return { topUp, settled: false };
        }
        topUp = (await this.store.update(topUp, { refundLedgerTransactionId: posting.transactionId })) ?? (await this.writer.reload(topUp.id));
        continue;
      }

      // 2. Razorpay refund (looked up first: an earlier attempt may have reached Razorpay without us hearing back)
      let refund: RazorpayRefund | null;
      try {
        refund = topUp.providerRefundId ? await this.razorpay.fetchRefund(topUp.providerRefundId) : await this.findOurRefund(topUp);
        if (!refund) {
          try {
            refund = await this.razorpay.refundPayment(topUp.providerPaymentId!, {
              amountPaise: refundAmount(topUp),
              receipt: topUp.refundId!,
              notes: { topUpId: topUp.id, refundId: topUp.refundId! },
            });
          } catch (error) {
            if (!(error instanceof RazorpayRequestError)) throw error;
            // A refusal can also mean "already refunded" by a concurrent attempt: only compensate if ours doesn't exist
            refund = await this.findOurRefund(topUp);
            if (!refund) {
              logger.warn(
                { alert: 'PAYMENT_REFUND_REJECTED', topUpId: topUp.id, code: error.providerCode, description: error.providerDescription },
                'Razorpay refused the refund; compensating'
              );
              topUp = (await this.store.update(topUp, { refundFailureReason: error.providerCode })) ?? (await this.writer.reload(topUp.id));
              continue;
            }
          }
        }
      } catch (error) {
        if (error instanceof HttpError && error.statusCode < 500) throw error;
        logger.error({ alert: 'PAYMENT_REFUND_STALLED', topUpId: topUp.id, stage: 'provider', err: (error as Error).message }, 'Refund did not reach Razorpay; will resume');
        return { topUp, settled: false };
      }
      if (topUp.providerRefundId !== refund.id) {
        topUp = (await this.store.update(topUp, { providerRefundId: refund.id })) ?? (await this.writer.reload(topUp.id));
        if (topUp.providerRefundId !== refund.id) continue;
      }

      // 3. Razorpay's verdict
      if (refund.status === 'processed') {
        const refunded = await this.writer.move({
          topUp,
          to: 'REFUNDED',
          source: ctx.source,
          actorId: ctx.actorId,
          correlationId: ctx.correlationId,
          data: { refundedAt: this.now() },
          audit: {
            actorId: ctx.actorId ?? SYSTEM_ACTOR,
            action: 'PAYMENT_REFUNDED',
            targetId: topUp.id,
            details: {
              refundId: topUp.refundId,
              providerRefundId: refund.id,
              amountPaise: String(refund.amount),
              ledgerTransactionId: topUp.refundLedgerTransactionId,
              source: ctx.source,
            },
          },
        });
        if (refunded) return { topUp: refunded, settled: true };
        topUp = await this.writer.reload(topUp.id);
        continue;
      }
      if (refund.status === 'failed') {
        topUp = (await this.store.update(topUp, { refundFailureReason: 'REFUND_FAILED' })) ?? (await this.writer.reload(topUp.id));
        continue;
      }
      return { topUp, settled: false }; // pending at Razorpay: the webhook or the reconciler finishes it
    }
    return { topUp, settled: false };
  }

  private async findOurRefund(topUp: TopUp): Promise<RazorpayRefund | null> {
    const refunds = await this.razorpay.fetchPaymentRefunds(topUp.providerPaymentId!);
    return refunds.find((r) => r.notes.refundId === topUp.refundId || r.receipt === topUp.refundId) ?? null;
  }

  /** The ledger refused the debit: nothing moved anywhere, so the top-up simply returns to CREDITED */
  private async ledgerRefused(topUp: TopUp, error: HttpError, ctx: RefundContext): Promise<RefundOutcome> {
    const back = await this.writer.move({
      topUp,
      to: 'CREDITED',
      source: ctx.source,
      actorId: ctx.actorId,
      reason: `REFUND_LEDGER_REFUSED:${error.errorCode}`,
      correlationId: ctx.correlationId,
      audit: {
        actorId: ctx.actorId ?? SYSTEM_ACTOR,
        action: 'PAYMENT_REFUND_FAILED',
        targetId: topUp.id,
        details: { refundId: topUp.refundId, stage: 'ledger', code: error.errorCode, compensated: false, source: ctx.source },
      },
    });
    if (!back) return this.advance(await this.writer.reload(topUp.id), ctx);
    if (ctx.interactive) {
      throw error.errorCode === 'INSUFFICIENT_FUNDS'
        ? PaymentErrors.refundInsufficientFunds()
        : new HttpError(409, error.errorCode, `The ledger refused the refund (${error.errorCode}); nothing was refunded`);
    }
    return { topUp: back, settled: true };
  }

  /** Razorpay refused or failed the refund: reverse the ledger debit, then return to where the refund started */
  private async compensate(topUp: TopUp, ctx: RefundContext): Promise<RefundOutcome> {
    let reversalId: string | null = null;
    if (topUp.refundLedgerTransactionId) {
      try {
        reversalId = (await this.ledger.reverseRefund(topUp.refundId!)).transactionId ?? null;
      } catch (error) {
        logger.error(
          { alert: 'PAYMENT_REFUND_COMPENSATION_STALLED', topUpId: topUp.id, err: (error as Error).message },
          'Could not reverse the refund debit yet; will retry'
        );
        return { topUp, settled: false };
      }
    }
    const backTo = topUp.ledgerTransactionId ? 'CREDITED' : 'CREDIT_BLOCKED';
    const back = await this.writer.move({
      topUp,
      to: backTo,
      source: ctx.source,
      actorId: ctx.actorId,
      reason: `REFUND_FAILED:${topUp.refundFailureReason}`,
      correlationId: ctx.correlationId,
      audit: {
        actorId: ctx.actorId ?? SYSTEM_ACTOR,
        action: 'PAYMENT_REFUND_FAILED',
        targetId: topUp.id,
        details: {
          refundId: topUp.refundId,
          stage: 'provider',
          code: topUp.refundFailureReason,
          compensated: Boolean(topUp.refundLedgerTransactionId),
          reversalTransactionId: reversalId,
          source: ctx.source,
        },
      },
    });
    if (!back) return this.advance(await this.writer.reload(topUp.id), ctx);
    if (ctx.interactive) throw PaymentErrors.refundRejected(topUp.refundFailureReason ?? 'REFUND_FAILED');
    return { topUp: back, settled: true };
  }
}

/** What goes back to the customer's card/UPI: what Razorpay actually captured */
function refundAmount(topUp: TopUp): bigint {
  return topUp.capturedAmountPaise ?? topUp.amountPaise;
}
