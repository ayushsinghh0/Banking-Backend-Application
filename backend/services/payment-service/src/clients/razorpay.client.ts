import { z } from 'zod';
import { CircuitBreaker, HttpError, retry } from '@banksphere/common';
import { razorpayRequestSeconds } from '../metrics';

// --- entities (only the fields this service uses; card/VPA/email/phone details are dropped on parse) -------

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const notes = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullish()
  .transform((value): Record<string, string> => {
    // Razorpay sends [] when there are no notes
    if (!value || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
  });

const orderSchema = z.object({
  id: z.string().min(1),
  entity: z.literal('order'),
  amount,
  amount_paid: amount.optional(),
  currency: z.string(),
  receipt: z.string().nullish(),
  status: z.string(),
  notes,
  created_at: z.number(),
});

const paymentSchema = z.object({
  id: z.string().min(1),
  entity: z.literal('payment'),
  amount,
  currency: z.string(),
  // created | authorized | captured | refunded | failed (unknown future states are treated as "not yet")
  status: z.string(),
  order_id: z.string().nullish(),
  method: z.string().nullish(),
  amount_refunded: amount.nullish(),
  refund_status: z.string().nullish(),
  captured: z.boolean().nullish(),
  error_code: z.string().nullish(),
  error_reason: z.string().nullish(),
  notes,
  created_at: z.number(),
});

const refundSchema = z.object({
  id: z.string().min(1),
  entity: z.literal('refund'),
  amount,
  currency: z.string(),
  payment_id: z.string(),
  receipt: z.string().nullish(),
  // pending | processed | failed
  status: z.string(),
  notes,
  created_at: z.number(),
});

const collection = <T extends z.ZodTypeAny>(item: T) => z.object({ entity: z.literal('collection'), count: z.number(), items: z.array(item) });

const checkoutResultSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export type RazorpayOrder = z.infer<typeof orderSchema>;
export type RazorpayPayment = z.infer<typeof paymentSchema>;
export type RazorpayRefund = z.infer<typeof refundSchema>;
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;

// --- errors ----------------------------------------------------------------------------------------------

/** Razorpay answered and refused (4xx). Carries Razorpay's own code/reason for the caller to decide on. */
export class RazorpayRequestError extends HttpError {
  constructor(
    readonly operation: string,
    readonly providerStatus: number,
    readonly providerCode: string,
    readonly providerDescription: string,
    readonly providerReason: string | null
  ) {
    super(502, 'PAYMENT_PROVIDER_ERROR', `Razorpay refused the request (${providerCode})`);
  }
}

/** Razorpay couldn't be reached, timed out, failed (5xx), throttled us (429) or the breaker is open */
export class RazorpayUnavailableError extends HttpError {
  constructor(readonly operation: string) {
    super(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is temporarily unavailable; please retry shortly');
  }
}

class TransientFailure extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
  }
}

// --- client ---------------------------------------------------------------------------------------------

export interface RazorpayApi {
  createOrder(input: { amountPaise: bigint; currency: 'INR'; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  capturePayment(paymentId: string, amountPaise: bigint, currency: string): Promise<RazorpayPayment>;
  refundPayment(paymentId: string, input: { amountPaise: bigint; receipt: string; notes: Record<string, string> }): Promise<RazorpayRefund>;
  fetchRefund(refundId: string): Promise<RazorpayRefund>;
  fetchPaymentRefunds(paymentId: string): Promise<RazorpayRefund[]>;
  /** Simulator only: pays an order the way Checkout would and returns the signed triple */
  simulateCheckout(orderId: string, input: { outcome: 'success' | 'failure'; method: string }): Promise<CheckoutResult>;
}

export interface RazorpayClientOptions {
  apiBase: string;
  keyId: string;
  keySecret: string;
  /** Per-attempt timeout for reads; writes (capture, refund) get 1.5x */
  timeoutMs: number;
  /** false disables the breaker (tests); default: opens at >= 50 % failures over >= 10 calls in 30 s */
  breaker?: CircuitBreaker | false;
  fetchImpl?: typeof fetch;
  /** Extra attempts for GETs after a transient failure */
  retries?: number;
  retryBaseMs?: number;
}

const RAZORPAY_ID = /^[A-Za-z0-9_]{1,64}$/;

function id(value: string): string {
  if (!RAZORPAY_ID.test(value)) throw new Error('Invalid Razorpay id');
  return value;
}

function toAmount(paise: bigint): number {
  if (paise <= 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount out of range for Razorpay');
  return Number(paise);
}

/**
 * Minimal Razorpay REST client. HTTP basic auth on the key pair; every call has its own timeout; GETs are
 * retried with jittered backoff (POSTs never: they may have taken effect); a circuit breaker stops hammering
 * an outage; Razorpay's `{ error: { code, description, reason } }` becomes RazorpayRequestError. Responses are
 * validated and stripped to the fields the service uses. Nothing here logs: callers log ids and outcomes only,
 * never the key secret, signatures, or card/UPI details.
 */
export class RazorpayClient implements RazorpayApi {
  private readonly base: string;
  private readonly authorization: string;
  private readonly breaker: CircuitBreaker | null;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly options: RazorpayClientOptions) {
    this.base = options.apiBase.replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;
    this.breaker =
      options.breaker === false
        ? null
        : (options.breaker ?? new CircuitBreaker({ name: 'razorpay', windowMs: 30_000, minimumRequests: 10, cooldownMs: 10_000 }));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 100;
  }

  public async createOrder(input: { amountPaise: bigint; currency: 'INR'; receipt: string; notes: Record<string, string> }) {
    const body = { amount: toAmount(input.amountPaise), currency: input.currency, receipt: input.receipt, notes: input.notes };
    return this.call('create_order', 'POST', '/v1/orders', orderSchema, body);
  }

  public async fetchOrder(orderId: string) {
    return this.call('fetch_order', 'GET', `/v1/orders/${id(orderId)}`, orderSchema);
  }

  public async fetchOrderPayments(orderId: string) {
    return (await this.call('fetch_order_payments', 'GET', `/v1/orders/${id(orderId)}/payments`, collection(paymentSchema))).items;
  }

  public async fetchPayment(paymentId: string) {
    return this.call('fetch_payment', 'GET', `/v1/payments/${id(paymentId)}`, paymentSchema);
  }

  public async capturePayment(paymentId: string, amountPaise: bigint, currency: string) {
    return this.call('capture_payment', 'POST', `/v1/payments/${id(paymentId)}/capture`, paymentSchema, {
      amount: toAmount(amountPaise),
      currency,
    }, 1.5);
  }

  public async refundPayment(paymentId: string, input: { amountPaise: bigint; receipt: string; notes: Record<string, string> }) {
    return this.call('refund_payment', 'POST', `/v1/payments/${id(paymentId)}/refund`, refundSchema, {
      amount: toAmount(input.amountPaise),
      speed: 'normal',
      receipt: input.receipt,
      notes: input.notes,
    }, 1.5);
  }

  public async fetchRefund(refundId: string) {
    return this.call('fetch_refund', 'GET', `/v1/refunds/${id(refundId)}`, refundSchema);
  }

  public async fetchPaymentRefunds(paymentId: string) {
    return (await this.call('fetch_payment_refunds', 'GET', `/v1/payments/${id(paymentId)}/refunds`, collection(refundSchema))).items;
  }

  public async simulateCheckout(orderId: string, input: { outcome: 'success' | 'failure'; method: string }) {
    return this.call('simulate_checkout', 'POST', `/sim/checkout/${id(orderId)}`, checkoutResultSchema, input);
  }

  private async call<S extends z.ZodTypeAny>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
    timeoutFactor = 1
  ): Promise<z.infer<S>> {
    const timeoutMs = Math.round(this.options.timeoutMs * timeoutFactor);
    const attempt = async (): Promise<z.infer<S>> => {
      const done = this.breaker?.acquire();
      if (this.breaker && !done) {
        razorpayRequestSeconds.observe({ operation, outcome: 'circuit_open' }, 0);
        throw new TransientFailure('circuit_open');
      }
      const started = process.hrtime.bigint();
      let outcome = 'ok';
      try {
        let response: Response;
        try {
          response = await this.fetchImpl(this.base + path, {
            method,
            headers: {
              authorization: this.authorization,
              accept: 'application/json',
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = (error as { name?: string })?.name;
          outcome = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
          throw new TransientFailure(outcome);
        }
        if (response.status === 429 || response.status >= 500) {
          outcome = response.status === 429 ? 'rate_limited' : 'server_error';
          await response.body?.cancel().catch(() => undefined);
          throw new TransientFailure(outcome);
        }
        const text = await response.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          outcome = 'invalid_response';
          throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID_RESPONSE', 'The payment provider returned an unreadable response');
        }
        if (!response.ok) {
          outcome = 'client_error';
          const error = (json as { error?: Record<string, unknown> } | undefined)?.error ?? {};
          throw new RazorpayRequestError(
            operation,
            response.status,
            typeof error.code === 'string' ? error.code.slice(0, 64) : 'UNKNOWN_ERROR',
            typeof error.description === 'string' ? error.description.slice(0, 200) : 'No description',
            typeof error.reason === 'string' && error.reason !== 'NA' ? error.reason.slice(0, 64) : null
          );
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          outcome = 'invalid_response';
          throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID_RESPONSE', 'The payment provider returned an unexpected response');
        }
        return parsed.data;
      } finally {
        // Only outages count against Razorpay's breaker; its refusals (4xx) are healthy answers
        done?.(!['timeout', 'network', 'rate_limited', 'server_error'].includes(outcome));
        razorpayRequestSeconds.observe({ operation, outcome }, Number(process.hrtime.bigint() - started) / 1e9);
      }
    };

    try {
      return await retry(attempt, {
        attempts: method === 'GET' ? this.retries + 1 : 1,
        baseMs: this.retryBaseMs,
        maxMs: this.retryBaseMs * 10,
        retryOn: (error) => error instanceof TransientFailure && error.outcome !== 'circuit_open',
      });
    } catch (error) {
      if (error instanceof TransientFailure) throw new RazorpayUnavailableError(operation);
      throw error;
    }
  }
}
