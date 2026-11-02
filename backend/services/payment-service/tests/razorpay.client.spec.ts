import { CircuitBreaker, metricsRegistry } from '@banksphere/common';
import { RazorpayClient, RazorpayRequestError, RazorpayUnavailableError } from '../src/clients/razorpay.client';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init);
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ORDER = { id: 'order_Abc123', entity: 'order', amount: 50000, amount_paid: 0, amount_due: 50000, currency: 'INR', receipt: 'r', status: 'created', attempts: 0, notes: [], created_at: 1 };
const PAYMENT = {
  id: 'pay_Xyz789',
  entity: 'payment',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  order_id: 'order_Abc123',
  method: 'card',
  amount_refunded: 0,
  refund_status: null,
  captured: true,
  card: { last4: '1111', network: 'Visa' },
  vpa: null,
  email: 'alice@example.com',
  contact: '+919999999999',
  created_at: 2,
};

const client = (impl: typeof fetch, breaker: CircuitBreaker | false = false) =>
  new RazorpayClient({
    apiBase: 'https://api.razorpay.com',
    keyId: 'rzp_test_KEY123',
    keySecret: 'secret_value_never_logged',
    timeoutMs: 1000,
    fetchImpl: impl,
    breaker,
    retryBaseMs: 1,
  });

async function observedCount(operation: string, outcome: string): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric('payments_razorpay_request_seconds')!.get();
  const sample = (metric.values as Array<{ metricName?: string; labels: Record<string, unknown>; value: number }>).find(
    (v) => v.metricName === 'payments_razorpay_request_seconds_count' && v.labels.operation === operation && v.labels.outcome === outcome
  );
  return Number(sample?.value ?? 0);
}

describe('RazorpayClient', () => {
  it('creates an order with HTTP basic auth on the key pair and a JSON body (amount as a number)', async () => {
    const { impl, calls } = fakeFetch([json(200, ORDER)]);
    const order = await client(impl).createOrder({ amountPaise: 50_000n, currency: 'INR', receipt: 'topup-1', notes: { topUpId: 'topup-1' } });
    expect(order.id).toBe('order_Abc123');
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_KEY123:secret_value_never_logged').toString('base64')}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ amount: 50000, currency: 'INR', receipt: 'topup-1', notes: { topUpId: 'topup-1' } });
  });

  it('keeps only the payment fields the service needs (no card, VPA, email or phone in memory)', async () => {
    const { impl } = fakeFetch([json(200, PAYMENT)]);
    const payment = await client(impl).fetchPayment('pay_Xyz789');
    expect(payment).toMatchObject({ id: 'pay_Xyz789', amount: 50000, currency: 'INR', status: 'captured', order_id: 'order_Abc123', method: 'card' });
    expect(payment).not.toHaveProperty('card');
    expect(payment).not.toHaveProperty('email');
    expect(payment).not.toHaveProperty('contact');
    expect(payment).not.toHaveProperty('vpa');
  });

  it('maps the Razorpay error format to a clean error, without retrying or leaking the secret', async () => {
    const { impl, calls } = fakeFetch([
      json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'This payment has already been captured', reason: 'NA', source: 'NA', step: 'NA' } }),
    ]);
    const error = await client(impl).capturePayment('pay_Xyz789', 50_000n, 'INR').catch((e) => e);
    expect(error).toBeInstanceOf(RazorpayRequestError);
    expect(error).toMatchObject({ providerStatus: 400, providerCode: 'BAD_REQUEST_ERROR', statusCode: 502 });
    expect(error.providerDescription).toBe('This payment has already been captured');
    expect(JSON.stringify(error)).not.toContain('secret_value_never_logged');
    expect(String(error.message)).not.toContain('secret_value_never_logged');
    expect(calls).toHaveLength(1);
    expect(await observedCount('capture_payment', 'client_error')).toBeGreaterThanOrEqual(1);
  });

  it('retries GETs on 5xx, 429 and network errors, then succeeds', async () => {
    const { impl, calls } = fakeFetch([json(502, {}), json(429, { error: { code: 'TOO_MANY_REQUESTS' } }), json(200, PAYMENT)]);
    await expect(client(impl).fetchPayment('pay_Xyz789')).resolves.toMatchObject({ id: 'pay_Xyz789' });
    expect(calls).toHaveLength(3);
  });

  it('never retries a POST (it may have taken effect): one attempt, then 503 PAYMENT_PROVIDER_UNAVAILABLE', async () => {
    const { impl, calls } = fakeFetch([json(503, {}), json(200, ORDER)]);
    const error = await client(impl)
      .createOrder({ amountPaise: 100n, currency: 'INR', receipt: 'r', notes: {} })
      .catch((e) => e);
    expect(error).toBeInstanceOf(RazorpayUnavailableError);
    expect(error).toMatchObject({ statusCode: 503, errorCode: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
  });

  it('times out each call and records the outcome', async () => {
    const before = await observedCount('fetch_order', 'timeout');
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
    const { impl, calls } = fakeFetch([hang, hang, hang]);
    const fast = new RazorpayClient({ apiBase: 'http://sim', keyId: 'rzp_test_A', keySecret: 's', timeoutMs: 20, fetchImpl: impl, breaker: false, retryBaseMs: 1 });
    await expect(fast.fetchOrder('order_1')).rejects.toBeInstanceOf(RazorpayUnavailableError);
    expect(calls).toHaveLength(3);
    expect(await observedCount('fetch_order', 'timeout')).toBe(before + 3);
  });

  it('rejects a response that is not a Razorpay entity', async () => {
    const { impl } = fakeFetch([json(200, { id: 'pay_1', entity: 'payment', amount: 1.5, currency: 'INR', status: 'captured', created_at: 1 })]);
    await expect(client(impl).fetchPayment('pay_1')).rejects.toMatchObject({ statusCode: 502, errorCode: 'PAYMENT_PROVIDER_INVALID_RESPONSE' });
  });

  it('refuses ids that are not Razorpay ids before calling out (no path injection)', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(client(impl).fetchPayment('../orders')).rejects.toThrow(/Invalid Razorpay id/);
    expect(calls).toHaveLength(0);
  });

  it('opens its circuit breaker on repeated outages and then fails fast without calling Razorpay', async () => {
    const breaker = new CircuitBreaker({ name: 'razorpay-test', minimumRequests: 2, failureRatio: 0.5, cooldownMs: 60_000 });
    const { impl, calls } = fakeFetch([json(500, {}), json(500, {})]);
    const c = new RazorpayClient({ apiBase: 'http://sim', keyId: 'rzp_test_A', keySecret: 's', timeoutMs: 100, fetchImpl: impl, breaker, retryBaseMs: 1 });
    await expect(c.createOrder({ amountPaise: 100n, currency: 'INR', receipt: 'r', notes: {} })).rejects.toBeInstanceOf(RazorpayUnavailableError);
    await expect(c.createOrder({ amountPaise: 100n, currency: 'INR', receipt: 'r', notes: {} })).rejects.toBeInstanceOf(RazorpayUnavailableError);
    expect(breaker.state).toBe('open');
    await expect(c.fetchPayment('pay_1')).rejects.toBeInstanceOf(RazorpayUnavailableError);
    expect(calls).toHaveLength(2);
    expect(await observedCount('fetch_payment', 'circuit_open')).toBeGreaterThanOrEqual(1);
  });

  it('lists the payments of an order and the refunds of a payment', async () => {
    const refund = { id: 'rfnd_1', entity: 'refund', amount: 50000, currency: 'INR', payment_id: 'pay_Xyz789', notes: { refundId: 'r1' }, receipt: 'r1', status: 'processed', created_at: 3 };
    const { impl, calls } = fakeFetch([
      json(200, { entity: 'collection', count: 1, items: [PAYMENT] }),
      json(200, { entity: 'collection', count: 1, items: [refund] }),
    ]);
    const c = client(impl);
    expect(await c.fetchOrderPayments('order_Abc123')).toHaveLength(1);
    expect((await c.fetchPaymentRefunds('pay_Xyz789'))[0]).toMatchObject({ id: 'rfnd_1', status: 'processed', notes: { refundId: 'r1' } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.razorpay.com/v1/orders/order_Abc123/payments',
      'https://api.razorpay.com/v1/payments/pay_Xyz789/refunds',
    ]);
  });
});
