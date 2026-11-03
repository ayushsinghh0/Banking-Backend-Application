import crypto from 'crypto';
import { Request } from 'express';
import { AuthenticatedUser, HttpError, can, logger } from '@banksphere/common';
import { CheckoutResult, RazorpayApi } from '../clients/razorpay.client';
import { CustomerApi } from '../clients/customer.client';
import { LedgerApi } from '../clients/ledger.client';
import { PaymentConfig } from '../config';
import { OPEN_STATUSES, PaymentStatus } from '../domain/status';
import { verifyPaymentSignature } from '../domain/signatures';
import { addMinutes, startOfIstDay } from '../domain/time';
import { HistoryEntry, Page, TopUp } from '../domain/types';
import { PaymentErrors } from '../errors';
import { PaymentStore } from '../store/payment-store';
import { SettlementService } from './settlement.service';
import { MAX_CAS_ATTEMPTS, StateWriter } from './state-writer';

export interface CheckoutDetails {
  keyId: string;
  orderId: string;
  amount: string;
  currency: string;
  name: string;
  description: string;
  prefill: { email: string };
}

export interface CreateTopUpResult {
  topUp: TopUp;
  checkout: CheckoutDetails;
  replayed: boolean;
}

export interface PaymentProof {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

/** Statuses where the customer's payment went through (credited, or at least taken and being handled) */
const PAID: readonly PaymentStatus[] = ['CAPTURED', 'CREDITED', 'CREDIT_BLOCKED', 'REFUND_PENDING', 'REFUNDED'];

export function requestHash(input: { accountId: string; amountPaise: bigint }): string {
  return crypto.createHash('sha256').update(JSON.stringify({ accountId: input.accountId, amountPaise: input.amountPaise.toString() })).digest('hex');
}

/**
 * The customer's side of top-ups: limits, creating an order, confirming the Checkout result, cancelling,
 * the simulator shortcut, and reading their own top-ups. Ownership is checked here on every call (a
 * permission never replaces it): a top-up that isn't the caller's is reported as not found.
 */
export class TopUpService {
  constructor(
    private readonly store: PaymentStore,
    private readonly writer: StateWriter,
    private readonly settlement: SettlementService,
    private readonly razorpay: RazorpayApi,
    private readonly ledger: LedgerApi,
    private readonly customers: CustomerApi,
    private readonly config: PaymentConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async getConfig(user: AuthenticatedUser) {
    const now = this.now();
    const used = await this.store.usedToday(user.id, startOfIstDay(now), now);
    const { minPaise, maxPaise, dailyLimitPaise } = this.config.limits;
    const remaining = dailyLimitPaise > used ? dailyLimitPaise - used : 0n;
    return {
      provider: 'RAZORPAY' as const,
      mode: this.config.mode,
      keyId: this.config.razorpay.keyId,
      limits: {
        minPaise: minPaise.toString(),
        maxPaise: maxPaise.toString(),
        dailyLimitPaise: dailyLimitPaise.toString(),
        usedTodayPaise: used.toString(),
        remainingTodayPaise: remaining.toString(),
      },
    };
  }

  public async create(
    user: AuthenticatedUser,
    idempotencyKey: string,
    input: { accountId: string; amountPaise: bigint },
    context?: Request
  ): Promise<CreateTopUpResult> {
    const hash = requestHash(input);
    const replay = await this.replay(user, idempotencyKey, hash);
    if (replay) return replay;

    const { minPaise, maxPaise, dailyLimitPaise, maxOpenOrders } = this.config.limits;
    if (input.amountPaise < minPaise) throw PaymentErrors.amountTooSmall(minPaise);
    if (input.amountPaise > maxPaise) throw PaymentErrors.amountTooLarge(maxPaise);

    if ((await this.customers.getKycStatus(user.id, context)) !== 'VERIFIED') throw PaymentErrors.kycNotVerified();
    const account = await this.ledger.getAccount(input.accountId, context).catch((error: unknown) => {
      if (error instanceof HttpError && error.statusCode === 404) throw PaymentErrors.accountNotFound();
      throw error;
    });
    // Another customer's account is "not found", never "forbidden": no probing for account ids
    if (account.customerId !== user.id || account.accountId !== input.accountId) throw PaymentErrors.accountNotFound();
    if (!account.isActive || account.closed) throw PaymentErrors.accountInactive();

    // Cheap early check so a refused request doesn't leave an unused Razorpay order behind; the authoritative
    // check runs again under the customer's lock when the top-up is inserted
    const now = this.now();
    const dayStart = startOfIstDay(now);
    const used = await this.store.usedToday(user.id, dayStart, now);
    if (used + input.amountPaise > dailyLimitPaise) throw PaymentErrors.dailyLimit(dailyLimitPaise > used ? dailyLimitPaise - used : 0n);

    const id = crypto.randomUUID();
    const last4 = account.accountNumberLast4.slice(-4);
    const order = await this.razorpay.createOrder({
      amountPaise: input.amountPaise,
      currency: 'INR',
      receipt: id,
      notes: { topUpId: id, accountLast4: last4 },
    });
    if (BigInt(order.amount) !== input.amountPaise || order.currency !== 'INR') {
      logger.error({ alert: 'RAZORPAY_ORDER_MISMATCH', topUpId: id, orderId: order.id }, 'Razorpay created an order with a different amount');
      throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider returned an unexpected order');
    }

    let result;
    try {
      result = await this.store.insertTopUp(
        {
          id,
          customerId: user.id,
          accountId: input.accountId,
          accountNumberLast4: last4,
          amountPaise: input.amountPaise,
          currency: 'INR',
          idempotencyKey,
          requestHash: hash,
          providerOrderId: order.id,
          expiresAt: addMinutes(now, this.config.orderTtlMinutes),
        },
        { maxOpenOrders, dailyLimitPaise, dayStart, now },
        { correlationId: context?.correlationId }
      );
    } catch (error) {
      // A concurrent request with the same key won the insert: answer exactly as it did (its Razorpay order is
      // the one in use; ours is never shown to anyone and simply lapses unpaid)
      if ((error as { code?: string })?.code === 'P2002') {
        const winner = await this.replay(user, idempotencyKey, hash);
        if (winner) return winner;
      }
      throw error;
    }
    if (!result.ok) {
      if (result.reason === 'TOO_MANY_OPEN') throw PaymentErrors.tooManyOpen(maxOpenOrders);
      throw PaymentErrors.dailyLimit(dailyLimitPaise > result.usedPaise ? dailyLimitPaise - result.usedPaise : 0n);
    }
    return { topUp: result.topUp, checkout: this.checkout(result.topUp, user), replayed: false };
  }

  private async replay(user: AuthenticatedUser, key: string, hash: string): Promise<CreateTopUpResult | null> {
    const existing = await this.store.findByIdempotencyKey(user.id, key);
    if (!existing) return null;
    if (existing.requestHash !== hash) throw PaymentErrors.idempotencyKeyReused();
    return { topUp: existing, checkout: this.checkout(existing, user), replayed: true };
  }

  private checkout(topUp: TopUp, user: AuthenticatedUser): CheckoutDetails {
    return {
      keyId: this.config.razorpay.keyId,
      orderId: topUp.providerOrderId,
      amount: topUp.amountPaise.toString(),
      currency: topUp.currency,
      name: this.config.checkoutName,
      description: `Add money to account ••${topUp.accountNumberLast4}`,
      prefill: { email: user.email },
    };
  }

  /**
   * The browser's Checkout result. The signature must verify against OUR order id for this top-up, and then the
   * payment is fetched from Razorpay and checked (order, amount, currency, status) before anything is credited:
   * the browser's word is never enough to move money.
   */
  public async confirm(user: AuthenticatedUser, topUpId: string, proof: PaymentProof, context?: Request): Promise<TopUp> {
    const topUp = await this.owned(user, topUpId);
    if (proof.razorpayOrderId !== topUp.providerOrderId) {
      (context?.log ?? logger).warn(
        { alert: 'PAYMENT_ORDER_MISMATCH', userId: user.id, topUpId, ip: context?.ip },
        'Checkout result names a different order than the top-up'
      );
      throw PaymentErrors.orderMismatch();
    }
    const valid = verifyPaymentSignature(
      { orderId: topUp.providerOrderId, paymentId: proof.razorpayPaymentId, signature: proof.razorpaySignature },
      this.config.razorpay.keySecret
    );
    if (!valid) {
      (context?.log ?? logger).warn(
        { alert: 'PAYMENT_SIGNATURE_INVALID', userId: user.id, topUpId, paymentId: proof.razorpayPaymentId, ip: context?.ip },
        'Rejected a Checkout result with an invalid signature'
      );
      throw PaymentErrors.invalidSignature();
    }
    // Already settled with this payment (a retried confirm, or the webhook got there first)
    if (topUp.providerPaymentId === proof.razorpayPaymentId && PAID.includes(topUp.status) && topUp.status !== 'CAPTURED') return topUp;

    const payment = await this.razorpay.fetchPayment(proof.razorpayPaymentId);
    const settled = await this.settlement.applyPayment(topUp.id, payment, {
      source: 'confirm',
      actorId: user.id,
      correlationId: context?.correlationId,
    });
    if (payment.status === 'failed' && !PAID.includes(settled.status)) throw PaymentErrors.notCaptured(settled.failureReason);
    return settled;
  }

  /** The customer dismissed Checkout: CREATED/PENDING -> CANCELLED (idempotent) */
  public async cancel(user: AuthenticatedUser, topUpId: string, context?: Request): Promise<TopUp> {
    let topUp = await this.owned(user, topUpId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      if (topUp.status === 'CANCELLED') return topUp;
      if (!OPEN_STATUSES.includes(topUp.status)) throw PaymentErrors.cannotCancel();
      const cancelled = await this.writer.move({
        topUp,
        to: 'CANCELLED',
        source: 'customer',
        actorId: user.id,
        reason: 'CHECKOUT_DISMISSED',
        correlationId: context?.correlationId,
      });
      if (cancelled) return cancelled;
      topUp = await this.writer.reload(topUpId);
    }
    throw PaymentErrors.cannotCancel();
  }

  /** Simulator mode only (never in production): pays the order the way Checkout would */
  public async simulate(
    user: AuthenticatedUser,
    topUpId: string,
    input: { outcome: 'success' | 'failure'; method: 'upi' | 'card' | 'netbanking' }
  ): Promise<CheckoutResult> {
    if (!this.config.simulateEnabled || process.env.NODE_ENV === 'production') throw PaymentErrors.simulatorOnly();
    const topUp = await this.owned(user, topUpId);
    if (!OPEN_STATUSES.includes(topUp.status)) {
      throw new HttpError(409, 'TOP_UP_NOT_PAYABLE', 'This top-up is no longer waiting for payment');
    }
    return this.razorpay.simulateCheckout(topUp.providerOrderId, input);
  }

  public async list(user: AuthenticatedUser, limit: number, cursor?: string): Promise<Page<TopUp>> {
    return this.store.listByCustomer(user.id, { limit, cursor });
  }

  /** The owner, or staff with payments:read:any (the route already admitted only those two) */
  public async get(user: AuthenticatedUser, topUpId: string): Promise<{ topUp: TopUp; history: HistoryEntry[]; staff: boolean }> {
    const topUp = await this.store.findById(topUpId);
    const staff = can(user, 'payments:read:any');
    if (!topUp || (!staff && topUp.customerId !== user.id)) throw PaymentErrors.topUpNotFound();
    return { topUp, history: await this.store.history(topUp.id), staff };
  }

  private async owned(user: AuthenticatedUser, topUpId: string): Promise<TopUp> {
    const topUp = await this.store.findById(topUpId);
    if (!topUp || topUp.customerId !== user.id) throw PaymentErrors.topUpNotFound();
    return topUp;
  }
}
