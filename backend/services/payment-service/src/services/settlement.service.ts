import { HttpError, logger } from '@banksphere/common';
import { RazorpayApi, RazorpayPayment, RazorpayRequestError } from '../clients/razorpay.client';
import { LedgerApi } from '../clients/ledger.client';
import { LATE_CAPTURE_STATUSES, OPEN_STATUSES } from '../domain/status';
import { TopUp, TransitionSource } from '../domain/types';
import { PaymentErrors, isNotCreditable } from '../errors';
import { PaymentStore } from '../store/payment-store';
import { MAX_CAS_ATTEMPTS, StateWriter } from './state-writer';

export interface SettleContext {
  source: TransitionSource;
  actorId?: string | null;
  correlationId?: string;
}

const SYSTEM_ACTOR = 'system:payment-service';

const isOpen = (t: TopUp) => OPEN_STATUSES.includes(t.status);
const isLate = (t: TopUp) => LATE_CAPTURE_STATUSES.includes(t.status);

/** Razorpay's failure reason as a short code we can store and show ("insufficient_funds" -> "INSUFFICIENT_FUNDS") */
export function failureCode(payment: Pick<RazorpayPayment, 'error_reason' | 'error_code'>): string {
  const raw = payment.error_reason ?? payment.error_code ?? '';
  return /^[A-Za-z_]{1,64}$/.test(raw) ? raw.toUpperCase() : 'PAYMENT_FAILED';
}

function sameMoney(topUp: TopUp, amount: bigint, currency: string): boolean {
  return amount === topUp.amountPaise && currency === topUp.currency;
}

/**
 * Settlement: turns what Razorpay says about a payment into top-up state and the ledger credit. Used by
 * confirm, the webhook and the reconciler alike, so all three reach the same answer, and safe to run
 * concurrently: every step is a compare-and-set, and the ledger credit is idempotent on the top-up id,
 * so a confirm racing a webhook still credits exactly once.
 *
 * Rules: the payment must belong to the top-up's own order; an authorized payment is captured only when its
 * amount and currency match; a capture is always recorded (late ones too: the customer's money was taken),
 * but credited only when the captured amount and currency equal the top-up's (otherwise CREDIT_BLOCKED, for
 * a refund); a ledger refusal (409) is CREDIT_BLOCKED; anything transient leaves it CAPTURED for the reconciler.
 */
export class SettlementService {
  constructor(
    private readonly store: PaymentStore,
    private readonly writer: StateWriter,
    private readonly razorpay: RazorpayApi,
    private readonly ledger: LedgerApi,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Applies one payment of the top-up's order (as fetched from Razorpay's API) and returns the new state */
  public async applyPayment(topUpId: string, payment: RazorpayPayment, ctx: SettleContext): Promise<TopUp> {
    let topUp = await this.writer.reload(topUpId);
    if (payment.order_id !== topUp.providerOrderId) {
      logger.warn(
        { alert: 'PAYMENT_ORDER_MISMATCH', topUpId, paymentId: payment.id, source: ctx.source },
        'A payment for a different order was presented for this top-up'
      );
      throw PaymentErrors.orderMismatch();
    }

    switch (payment.status) {
      case 'captured':
        topUp = await this.recordCapture(topUp, payment, ctx);
        return this.creditIfDue(topUp, ctx);
      case 'authorized':
        return this.captureAuthorized(topUp, payment, ctx);
      case 'failed':
        return this.recordFailure(topUp, payment, ctx);
      case 'created':
        return this.recordAttempt(topUp, payment, ctx);
      case 'refunded':
        // Captured and then refunded at Razorpay (e.g. from the dashboard): never credit money already returned
        if (isOpen(topUp) || isLate(topUp)) {
          logger.error(
            { alert: 'PAYMENT_REFUNDED_OUT_OF_BAND', topUpId, paymentId: payment.id },
            'Razorpay reports a refunded payment for a top-up that was never credited; not crediting'
          );
        }
        return topUp;
      default:
        return topUp;
    }
  }

  /** Asks Razorpay about every payment of the order and applies the one that matters most */
  public async syncOrder(topUp: TopUp, ctx: SettleContext, payments?: RazorpayPayment[]): Promise<TopUp> {
    const all = payments ?? (await this.razorpay.fetchOrderPayments(topUp.providerOrderId));
    const rank = (p: RazorpayPayment) => ({ captured: 0, authorized: 1, created: 2, failed: 3 })[p.status] ?? 4;
    const ordered = all.filter((p) => p.order_id === topUp.providerOrderId).sort((a, b) => rank(a) - rank(b) || b.created_at - a.created_at);
    const best = ordered[0];
    if (!best || rank(best) > 3) return topUp;
    const extraCaptures = ordered.filter((p) => p.status === 'captured' && p.id !== best.id);
    if (best.status === 'captured' && extraCaptures.length) {
      // Razorpay normally allows one successful payment per order; any other one needs a manual refund
      logger.error(
        { alert: 'PAYMENT_DUPLICATE_CAPTURE', topUpId: topUp.id, paymentIds: extraCaptures.map((p) => p.id) },
        'More than one captured payment for one top-up order'
      );
    }
    return this.applyPayment(topUp.id, best, ctx);
  }

  /** CAPTURED -> CREDITED (or CREDIT_BLOCKED); a no-op in any other state */
  public async creditIfDue(start: TopUp, ctx: SettleContext): Promise<TopUp> {
    let topUp = start;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      if (topUp.status !== 'CAPTURED') return topUp;

      if (topUp.capturedAmountPaise === null || !sameMoney(topUp, topUp.capturedAmountPaise, topUp.capturedCurrency ?? '')) {
        logger.error(
          {
            alert: 'PAYMENT_AMOUNT_MISMATCH',
            topUpId: topUp.id,
            expectedPaise: topUp.amountPaise.toString(),
            capturedPaise: topUp.capturedAmountPaise?.toString() ?? null,
            capturedCurrency: topUp.capturedCurrency,
          },
          'Captured amount or currency differs from the top-up; credit blocked'
        );
        const blocked = await this.block(topUp, 'AMOUNT_MISMATCH', ctx);
        if (blocked) return blocked;
        topUp = await this.writer.reload(topUp.id);
        continue;
      }

      let posting;
      try {
        posting = await this.ledger.credit({
          topUpId: topUp.id,
          accountId: topUp.accountId,
          customerId: topUp.customerId,
          amountPaise: topUp.amountPaise,
          providerPaymentId: topUp.providerPaymentId!,
        });
      } catch (error) {
        if (isNotCreditable(error)) {
          const code = (error as HttpError).errorCode;
          logger.warn({ alert: 'PAYMENT_CREDIT_BLOCKED', topUpId: topUp.id, code }, 'The ledger refused the top-up credit');
          const blocked = await this.block(topUp, code, ctx);
          if (blocked) return blocked;
          topUp = await this.writer.reload(topUp.id);
          continue;
        }
        // Unknown outcome or ledger down: stays CAPTURED; the credit is idempotent, so the reconciler retries it
        logger.error(
          { alert: 'PAYMENT_CREDIT_PENDING', topUpId: topUp.id, err: (error as Error).message },
          'Ledger credit did not complete; the reconciler will retry'
        );
        return topUp;
      }

      const credited = await this.writer.move({
        topUp,
        to: 'CREDITED',
        source: ctx.source,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
        data: { ledgerTransactionId: posting.transactionId, creditedAt: this.now(), failureReason: null },
      });
      if (credited) return credited;
      topUp = await this.writer.reload(topUp.id);
      if (topUp.status === 'CREDIT_BLOCKED') {
        // Our credit posted, yet a concurrent attempt saw a refusal: the ledger and this record disagree
        logger.fatal(
          { alert: 'PAYMENT_LEDGER_STATE_DIVERGED', topUpId: topUp.id, ledgerTransactionId: posting.transactionId },
          'Top-up is CREDIT_BLOCKED but the ledger credit posted; resolve manually before any refund'
        );
        await this.store.appendAudit({
          actorId: SYSTEM_ACTOR,
          action: 'PAYMENT_LEDGER_STATE_DIVERGED',
          targetId: topUp.id,
          details: { ledgerTransactionId: posting.transactionId, status: topUp.status },
        });
        return topUp;
      }
    }
    return topUp;
  }

  private async block(topUp: TopUp, reason: string, ctx: SettleContext): Promise<TopUp | null> {
    return this.writer.move({
      topUp,
      to: 'CREDIT_BLOCKED',
      source: ctx.source,
      actorId: ctx.actorId,
      reason,
      correlationId: ctx.correlationId,
      data: { failureReason: reason },
      audit: {
        actorId: ctx.actorId ?? SYSTEM_ACTOR,
        action: 'PAYMENT_CREDIT_BLOCKED',
        targetId: topUp.id,
        details: {
          reason,
          source: ctx.source,
          amountPaise: topUp.amountPaise.toString(),
          capturedAmountPaise: topUp.capturedAmountPaise?.toString() ?? null,
          capturedCurrency: topUp.capturedCurrency,
          providerPaymentId: topUp.providerPaymentId,
          accountId: topUp.accountId,
        },
      },
    });
  }

  /** Records a captured payment: open or ended (late capture) -> CAPTURED. Already captured: unchanged. */
  private async recordCapture(start: TopUp, payment: RazorpayPayment, ctx: SettleContext): Promise<TopUp> {
    let topUp = start;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      if (!isOpen(topUp) && !isLate(topUp)) {
        if (topUp.providerPaymentId && topUp.providerPaymentId !== payment.id) {
          logger.error(
            { alert: 'PAYMENT_DUPLICATE_CAPTURE', topUpId: topUp.id, paymentId: payment.id, recordedPaymentId: topUp.providerPaymentId },
            'A second captured payment arrived for an already captured top-up; it needs a manual refund'
          );
        }
        return topUp;
      }
      const late = isLate(topUp);
      if (late) logger.warn({ topUpId: topUp.id, from: topUp.status, paymentId: payment.id }, 'Late capture: crediting an ended top-up');
      const captured = await this.writer.move({
        topUp,
        to: 'CAPTURED',
        source: ctx.source,
        actorId: ctx.actorId,
        reason: late ? 'LATE_CAPTURE' : null,
        correlationId: ctx.correlationId,
        data: {
          providerPaymentId: payment.id,
          method: payment.method ?? null,
          capturedAmountPaise: BigInt(payment.amount),
          capturedCurrency: payment.currency,
          capturedAt: this.now(),
          failureReason: null,
        },
      });
      if (captured) return captured;
      topUp = await this.writer.reload(topUp.id);
    }
    return topUp;
  }

  private async captureAuthorized(start: TopUp, payment: RazorpayPayment, ctx: SettleContext): Promise<TopUp> {
    let topUp = start;
    if (!isOpen(topUp) && !isLate(topUp)) return this.recordCapture(topUp, payment, ctx); // logs a duplicate if any
    if (!sameMoney(topUp, BigInt(payment.amount), payment.currency)) {
      // Never take money we couldn't credit: the authorization is left to lapse (Razorpay releases it)
      logger.error(
        { alert: 'PAYMENT_AMOUNT_MISMATCH', topUpId: topUp.id, paymentId: payment.id, capturedPaise: String(payment.amount), currency: payment.currency },
        'Authorized amount or currency differs from the top-up; not capturing'
      );
      return isOpen(topUp) ? this.fail(topUp, payment.id, 'AMOUNT_MISMATCH', ctx) : topUp;
    }
    if (topUp.status === 'CREATED') {
      topUp = (await this.writer.move({
        topUp,
        to: 'PENDING',
        source: ctx.source,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
        data: { providerPaymentId: payment.id, method: payment.method ?? null },
      })) ?? (await this.writer.reload(topUp.id));
    }

    let captured: RazorpayPayment;
    try {
      captured = await this.razorpay.capturePayment(payment.id, topUp.amountPaise, topUp.currency);
    } catch (error) {
      // "already captured" (by a concurrent confirm/webhook, or auto-capture): read the truth and carry on
      if (!(error instanceof RazorpayRequestError)) throw error;
      captured = await this.razorpay.fetchPayment(payment.id);
      if (captured.status !== 'captured') throw error;
    }
    if (captured.status !== 'captured' || captured.order_id !== topUp.providerOrderId) return topUp;
    topUp = await this.recordCapture(await this.writer.reload(topUp.id), captured, ctx);
    return this.creditIfDue(topUp, ctx);
  }

  private async recordFailure(topUp: TopUp, payment: RazorpayPayment, ctx: SettleContext): Promise<TopUp> {
    // Only an order still waiting for payment fails; a PENDING order whose authorized payment is a different
    // one keeps waiting for that payment
    if (!isOpen(topUp)) return topUp;
    if (topUp.status === 'PENDING' && topUp.providerPaymentId && topUp.providerPaymentId !== payment.id) return topUp;
    return this.fail(topUp, payment.id, failureCode(payment), ctx);
  }

  private async fail(start: TopUp, paymentId: string, reason: string, ctx: SettleContext): Promise<TopUp> {
    let topUp = start;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && isOpen(topUp); attempt++) {
      const failed = await this.writer.move({
        topUp,
        to: 'FAILED',
        source: ctx.source,
        actorId: ctx.actorId,
        reason,
        correlationId: ctx.correlationId,
        data: { failureReason: reason, providerPaymentId: topUp.providerPaymentId ?? paymentId },
      });
      if (failed) return failed;
      topUp = await this.writer.reload(topUp.id);
    }
    return topUp;
  }

  private async recordAttempt(topUp: TopUp, payment: RazorpayPayment, ctx: SettleContext): Promise<TopUp> {
    if (topUp.status !== 'CREATED') return topUp;
    return (
      (await this.writer.move({
        topUp,
        to: 'PENDING',
        source: ctx.source,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
        data: { providerPaymentId: payment.id, method: payment.method ?? null },
      })) ?? (await this.writer.reload(topUp.id))
    );
  }
}
