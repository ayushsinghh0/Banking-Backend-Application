import crypto from 'crypto';
import { HttpError } from '@banksphere/common';
import {
  CheckoutResult,
  RazorpayApi,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayRefund,
  RazorpayRequestError,
  RazorpayUnavailableError,
} from '../../src/clients/razorpay.client';
import { LedgerApi, LedgerPaymentAccount, LedgerPosting } from '../../src/clients/ledger.client';
import { CustomerApi, KycStatus } from '../../src/clients/customer.client';

const io = () => new Promise<void>((resolve) => setImmediate(resolve));
let counter = 0;
const rid = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}${crypto.randomBytes(4).toString('hex')}`;

type RefundBehaviour = 'processed' | 'pending' | 'failed' | 'reject' | 'unavailable' | 'timeout_after_create';

/** Razorpay as a small in-memory state machine (orders, payments, refunds), with switchable failures */
export class FakeRazorpay implements RazorpayApi {
  public readonly orders = new Map<string, RazorpayOrder>();
  public readonly payments = new Map<string, RazorpayPayment>();
  public readonly refunds = new Map<string, RazorpayRefund>();
  public readonly calls: string[] = [];
  public refundBehaviour: RefundBehaviour = 'processed';
  /** Operations that fail as if Razorpay were down */
  public readonly down = new Set<string>();

  constructor(private readonly keySecret: string) {}

  private async enter(operation: string) {
    this.calls.push(operation);
    await io();
    if (this.down.has(operation)) throw new RazorpayUnavailableError(operation);
  }

  private notFound(operation: string): never {
    throw new RazorpayRequestError(operation, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist', null);
  }

  public count(operation: string): number {
    return this.calls.filter((c) => c === operation).length;
  }

  /** Test helper: a payment on an order, as Checkout would create it */
  public pay(orderId: string, opts: { status: RazorpayPayment['status']; amount?: number; currency?: string; method?: string; errorReason?: string }) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`no order ${orderId}`);
    const payment: RazorpayPayment = {
      id: rid('pay'),
      entity: 'payment',
      amount: opts.amount ?? order.amount,
      currency: opts.currency ?? order.currency,
      status: opts.status,
      order_id: orderId,
      method: opts.method ?? 'upi',
      amount_refunded: 0,
      refund_status: null,
      captured: opts.status === 'captured',
      error_code: opts.status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_reason: opts.status === 'failed' ? (opts.errorReason ?? 'payment_failed') : null,
      notes: {},
      created_at: Math.floor(Date.now() / 1000) + this.payments.size,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  public sign(orderId: string, paymentId: string): string {
    return crypto.createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  }

  async createOrder(input: { amountPaise: bigint; currency: 'INR'; receipt: string; notes: Record<string, string> }) {
    await this.enter('createOrder');
    const order: RazorpayOrder = {
      id: rid('order'),
      entity: 'order',
      amount: Number(input.amountPaise),
      amount_paid: 0,
      currency: input.currency,
      receipt: input.receipt,
      status: 'created',
      notes: input.notes,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.orders.set(order.id, order);
    return { ...order };
  }

  async fetchOrder(orderId: string) {
    await this.enter('fetchOrder');
    const order = this.orders.get(orderId);
    return order ? { ...order } : this.notFound('fetch_order');
  }

  async fetchOrderPayments(orderId: string) {
    await this.enter('fetchOrderPayments');
    return [...this.payments.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p }));
  }

  async fetchPayment(paymentId: string) {
    await this.enter('fetchPayment');
    const payment = this.payments.get(paymentId);
    return payment ? { ...payment } : this.notFound('fetch_payment');
  }

  async capturePayment(paymentId: string, amountPaise: bigint, currency: string) {
    await this.enter('capturePayment');
    const payment = this.payments.get(paymentId) ?? this.notFound('capture_payment');
    if (payment.status === 'captured') {
      throw new RazorpayRequestError('capture_payment', 400, 'BAD_REQUEST_ERROR', 'This payment has already been captured', null);
    }
    if (payment.status !== 'authorized' || BigInt(payment.amount) !== amountPaise || payment.currency !== currency) {
      throw new RazorpayRequestError('capture_payment', 400, 'BAD_REQUEST_ERROR', 'Capture amount must be equal to the amount authorized', null);
    }
    payment.status = 'captured';
    payment.captured = true;
    return { ...payment };
  }

  async refundPayment(paymentId: string, input: { amountPaise: bigint; receipt: string; notes: Record<string, string> }) {
    await this.enter('refundPayment');
    const payment = this.payments.get(paymentId) ?? this.notFound('refund_payment');
    if (this.refundBehaviour === 'unavailable') throw new RazorpayUnavailableError('refund_payment');
    if (this.refundBehaviour === 'reject' || payment.status !== 'captured' || (payment.amount_refunded ?? 0) + Number(input.amountPaise) > payment.amount) {
      throw new RazorpayRequestError('refund_payment', 400, 'BAD_REQUEST_ERROR', 'The refund amount is greater than the refundable amount', null);
    }
    const status = this.refundBehaviour === 'pending' ? 'pending' : this.refundBehaviour === 'failed' ? 'failed' : 'processed';
    const refund: RazorpayRefund = {
      id: rid('rfnd'),
      entity: 'refund',
      amount: Number(input.amountPaise),
      currency: payment.currency,
      payment_id: paymentId,
      receipt: input.receipt,
      status: this.refundBehaviour === 'timeout_after_create' ? 'processed' : status,
      notes: input.notes,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.refunds.set(refund.id, refund);
    if (refund.status !== 'failed') payment.amount_refunded = (payment.amount_refunded ?? 0) + refund.amount;
    // Razorpay made the refund, but its answer never reached us
    if (this.refundBehaviour === 'timeout_after_create') throw new RazorpayUnavailableError('refund_payment');
    return { ...refund };
  }

  async fetchRefund(refundId: string) {
    await this.enter('fetchRefund');
    const refund = this.refunds.get(refundId);
    return refund ? { ...refund } : this.notFound('fetch_refund');
  }

  async fetchPaymentRefunds(paymentId: string) {
    await this.enter('fetchPaymentRefunds');
    return [...this.refunds.values()].filter((r) => r.payment_id === paymentId).map((r) => ({ ...r }));
  }

  async simulateCheckout(orderId: string, input: { outcome: 'success' | 'failure'; method: string }): Promise<CheckoutResult> {
    await this.enter('simulateCheckout');
    const payment = this.pay(orderId, { status: input.outcome === 'success' ? 'captured' : 'failed', method: input.method });
    return { razorpay_payment_id: payment.id, razorpay_order_id: orderId, razorpay_signature: this.sign(orderId, payment.id) };
  }
}

type Account = LedgerPaymentAccount & { balance: bigint };

/** The ledger's payments API: idempotent postings, a balance per account, switchable refusals and outages */
export class FakeLedger implements LedgerApi {
  public readonly accounts = new Map<string, Account>();
  public readonly credits = new Map<string, LedgerPosting & { amount: bigint; accountId: string }>();
  public readonly refundDebits = new Map<string, LedgerPosting & { amount: bigint; accountId: string }>();
  public readonly reversals = new Map<string, LedgerPosting>();
  public creditBehaviour: 'ok' | 'not_creditable' | 'unavailable' = 'ok';
  public refundBehaviour: 'ok' | 'unavailable' = 'ok';
  public reverseBehaviour: 'ok' | 'unavailable' = 'ok';
  public creditCalls = 0;
  public refundCalls = 0;
  public reverseCalls = 0;

  public addAccount(customerId: string, opts: Partial<Account> = {}): Account {
    const account: Account = {
      accountId: crypto.randomUUID(),
      customerId,
      accountNumberLast4: String(1000 + this.accounts.size).slice(-4),
      isActive: true,
      closed: false,
      balance: 0n,
      ...opts,
    };
    this.accounts.set(account.accountId, account);
    return account;
  }

  async getAccount(accountId: string) {
    await io();
    const account = this.accounts.get(accountId);
    if (!account) throw new HttpError(404, 'NOT_FOUND', 'Account not found');
    const { balance: _balance, ...view } = account;
    return view;
  }

  async credit(input: { topUpId: string; accountId: string; customerId: string; amountPaise: bigint; providerPaymentId: string }) {
    this.creditCalls += 1;
    await io();
    if (this.creditBehaviour === 'unavailable') throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'ledger-payments is temporarily unavailable');
    const existing = this.credits.get(input.topUpId);
    if (existing) return { transactionId: existing.transactionId, referenceId: existing.referenceId, replayed: true };
    const account = this.accounts.get(input.accountId);
    if (this.creditBehaviour === 'not_creditable' || !account || !account.isActive || account.closed || account.customerId !== input.customerId) {
      throw new HttpError(409, 'ACCOUNT_NOT_CREDITABLE', 'The account cannot receive this credit');
    }
    const posting = { transactionId: crypto.randomUUID(), referenceId: `TOPUP-${input.topUpId}`, replayed: false };
    this.credits.set(input.topUpId, { ...posting, amount: input.amountPaise, accountId: input.accountId });
    account.balance += input.amountPaise;
    return posting;
  }

  async debitRefund(input: { refundId: string; topUpId: string; accountId: string; customerId: string; amountPaise: bigint }) {
    this.refundCalls += 1;
    await io();
    if (this.refundBehaviour === 'unavailable') throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'ledger-payments is temporarily unavailable');
    const existing = this.refundDebits.get(input.refundId);
    if (existing) return { transactionId: existing.transactionId, referenceId: existing.referenceId, replayed: true };
    const account = this.accounts.get(input.accountId)!;
    if (account.balance < input.amountPaise) throw new HttpError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    const posting = { transactionId: crypto.randomUUID(), referenceId: `TOPUP-REFUND-${input.refundId}`, replayed: false };
    this.refundDebits.set(input.refundId, { ...posting, amount: input.amountPaise, accountId: input.accountId });
    account.balance -= input.amountPaise;
    return posting;
  }

  async reverseRefund(refundId: string) {
    this.reverseCalls += 1;
    await io();
    if (this.reverseBehaviour === 'unavailable') throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'ledger-payments is temporarily unavailable');
    const existing = this.reversals.get(refundId);
    if (existing) return { ...existing, replayed: true };
    const debit = this.refundDebits.get(refundId);
    if (!debit) throw new HttpError(404, 'NOT_FOUND', 'No refund debit to reverse');
    const posting = { transactionId: crypto.randomUUID(), referenceId: `TOPUP-REFUND-REV-${refundId}`, replayed: false };
    this.reversals.set(refundId, posting);
    this.accounts.get(debit.accountId)!.balance += debit.amount;
    return posting;
  }

  public balance(accountId: string): bigint {
    return this.accounts.get(accountId)!.balance;
  }
}

export class FakeCustomers implements CustomerApi {
  public readonly kyc = new Map<string, KycStatus>();
  public defaultStatus: KycStatus = 'VERIFIED';

  async getKycStatus(userId: string) {
    await io();
    return this.kyc.get(userId) ?? this.defaultStatus;
  }
}
