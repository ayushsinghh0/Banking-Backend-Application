import { RazorpayErrors } from './errors';
import { razorpayId } from './signatures';

export type OrderStatus = 'created' | 'attempted' | 'paid';
export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
export type RefundStatus = 'pending' | 'processed' | 'failed';
export type PaymentMethod = 'upi' | 'card' | 'netbanking';
/** How a simulated checkout ends: paid and captured, authorized only (manual capture), or declined */
export type CheckoutOutcome = 'success' | 'authorized' | 'failure';

/** Entities as Razorpay's API returns them (the fields the real API documents; amounts in paise) */
export interface SimOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  offer_id: null;
  status: OrderStatus;
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface SimPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: PaymentStatus;
  order_id: string;
  invoice_id: null;
  international: false;
  method: PaymentMethod;
  amount_refunded: number;
  refund_status: null | 'partial' | 'full';
  captured: boolean;
  description: string | null;
  card_id: string | null;
  bank: string | null;
  wallet: null;
  vpa: string | null;
  email: string;
  contact: string;
  notes: Record<string, string>;
  fee: number | null;
  tax: number | null;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  acquirer_data: Record<string, string>;
  created_at: number;
}

export interface SimRefund {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  notes: Record<string, string>;
  receipt: string | null;
  acquirer_data: Record<string, string>;
  created_at: number;
  batch_id: null;
  status: RefundStatus;
  speed_processed: 'normal';
  speed_requested: 'normal';
}

export interface CreateOrderInput {
  amount: number;
  currency: string;
  receipt?: string | null;
  notes?: Record<string, string>;
}

export interface RefundInput {
  amount?: number;
  receipt?: string | null;
  notes?: Record<string, string>;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Razorpay's state, in memory, with its rules: an order takes payment attempts until one is captured
 * (then it is `paid` and takes no more); only an `authorized` payment can be captured, for exactly its
 * amount; only a captured payment can be refunded, up to what remains. Nothing here knows about HTTP or
 * webhooks; the routes render entities and the dispatcher announces changes.
 */
export class SimulatorStore {
  public readonly orders = new Map<string, SimOrder>();
  public readonly payments = new Map<string, SimPayment>();
  public readonly refunds = new Map<string, SimRefund>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private epoch(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  public createOrder(input: CreateOrderInput): SimOrder {
    const order: SimOrder = {
      id: razorpayId('order'),
      entity: 'order',
      amount: input.amount,
      amount_paid: 0,
      amount_due: input.amount,
      currency: input.currency,
      receipt: input.receipt ?? null,
      offer_id: null,
      status: 'created',
      attempts: 0,
      notes: { ...(input.notes ?? {}) },
      created_at: this.epoch(),
    };
    this.orders.set(order.id, order);
    return clone(order);
  }

  public getOrder(id: string): SimOrder {
    const order = this.orders.get(id);
    if (!order) throw RazorpayErrors.notFound();
    return clone(order);
  }

  public getPayment(id: string): SimPayment {
    const payment = this.payments.get(id);
    if (!payment) throw RazorpayErrors.notFound();
    return clone(payment);
  }

  public getRefund(id: string): SimRefund {
    const refund = this.refunds.get(id);
    if (!refund) throw RazorpayErrors.notFound();
    return clone(refund);
  }

  public paymentsOf(orderId: string): SimPayment[] {
    this.getOrder(orderId);
    return [...this.payments.values()].filter((p) => p.order_id === orderId).map(clone);
  }

  public refundsOf(paymentId: string): SimRefund[] {
    this.getPayment(paymentId);
    return [...this.refunds.values()].filter((r) => r.payment_id === paymentId).map(clone);
  }

  /** A customer paying the order through Checkout; the result depends only on the requested outcome */
  public checkout(orderId: string, outcome: CheckoutOutcome, method: PaymentMethod): SimPayment {
    const order = this.orders.get(orderId);
    if (!order) throw RazorpayErrors.notFound();
    if (order.status === 'paid') throw RazorpayErrors.refused('Order has already been paid');

    const failed = outcome === 'failure';
    const payment: SimPayment = {
      id: razorpayId('pay'),
      entity: 'payment',
      amount: order.amount,
      currency: order.currency,
      status: outcome === 'success' ? 'captured' : outcome === 'authorized' ? 'authorized' : 'failed',
      order_id: order.id,
      invoice_id: null,
      international: false,
      method,
      amount_refunded: 0,
      refund_status: null,
      captured: outcome === 'success',
      description: null,
      card_id: method === 'card' ? razorpayId('card') : null,
      bank: method === 'netbanking' ? 'HDFC' : null,
      wallet: null,
      vpa: method === 'upi' ? (failed ? 'failure@razorpay' : 'success@razorpay') : null,
      email: 'customer@simulator.invalid',
      contact: '+910000000000',
      notes: {},
      fee: outcome === 'success' ? 0 : null,
      tax: outcome === 'success' ? 0 : null,
      error_code: failed ? 'BAD_REQUEST_ERROR' : null,
      error_description: failed ? 'Payment failed because the customer declined or the bank refused it (simulated)' : null,
      error_source: failed ? 'customer' : null,
      error_step: failed ? 'payment_authentication' : null,
      error_reason: failed ? 'payment_failed' : null,
      acquirer_data: method === 'upi' ? { rrn: String(this.epoch()).padStart(12, '0') } : {},
      created_at: this.epoch(),
    };
    this.payments.set(payment.id, payment);
    order.attempts += 1;
    if (outcome === 'success') this.markPaid(order, payment);
    else order.status = 'attempted';
    return clone(payment);
  }

  /** POST /v1/payments/:id/capture: the merchant takes an authorized amount */
  public capture(paymentId: string, amount: number, currency: string): SimPayment {
    const payment = this.payments.get(paymentId);
    if (!payment) throw RazorpayErrors.notFound();
    if (payment.status === 'captured' || payment.status === 'refunded') throw RazorpayErrors.refused('This payment has already been captured');
    if (payment.status !== 'authorized') throw RazorpayErrors.refused('This payment has not been authorized');
    if (amount !== payment.amount || currency !== payment.currency) {
      throw RazorpayErrors.invalid('Capture amount must be equal to the amount authorized', 'amount');
    }
    payment.status = 'captured';
    payment.captured = true;
    payment.fee = 0;
    payment.tax = 0;
    this.markPaid(this.orders.get(payment.order_id)!, payment);
    return clone(payment);
  }

  /** POST /v1/payments/:id/refund: processed at once (the simulator has no settlement cycle) */
  public refund(paymentId: string, input: RefundInput): SimRefund {
    const payment = this.payments.get(paymentId);
    if (!payment) throw RazorpayErrors.notFound();
    if (!payment.captured) throw RazorpayErrors.refused('The payment has not been captured');
    const remaining = payment.amount - payment.amount_refunded;
    if (remaining === 0) throw RazorpayErrors.refused('The payment has been fully refunded already');
    const amount = input.amount ?? remaining;
    if (amount > remaining) throw RazorpayErrors.invalid('The total refund amount is greater than the refund payment amount', 'amount');

    const refund: SimRefund = {
      id: razorpayId('rfnd'),
      entity: 'refund',
      amount,
      currency: payment.currency,
      payment_id: payment.id,
      notes: { ...(input.notes ?? {}) },
      receipt: input.receipt ?? null,
      acquirer_data: {},
      created_at: this.epoch(),
      batch_id: null,
      status: 'processed',
      speed_processed: 'normal',
      speed_requested: 'normal',
    };
    this.refunds.set(refund.id, refund);
    payment.amount_refunded += amount;
    payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
    if (payment.refund_status === 'full') payment.status = 'refunded';
    return clone(refund);
  }

  private markPaid(order: SimOrder, payment: SimPayment): void {
    order.amount_paid = payment.amount;
    order.amount_due = Math.max(0, order.amount - payment.amount);
    order.status = 'paid';
  }
}
