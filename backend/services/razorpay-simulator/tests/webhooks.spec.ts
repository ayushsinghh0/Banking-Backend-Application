import { WebhookDispatcher } from '../src/webhooks';
import { buildHarness, Harness, WEBHOOK_SECRET, startReceiver, verifyWebhookSignature } from './support/harness';

type Receiver = Awaited<ReturnType<typeof startReceiver>>;

describe('webhook delivery to SIM_WEBHOOK_URL', () => {
  let receiver: Receiver;
  let h: Harness;

  beforeEach(async () => {
    receiver = await startReceiver();
    h = buildHarness({ config: { webhookUrl: receiver.url } });
  });
  afterEach(async () => {
    await h.webhooks.idle();
    await receiver.close();
  });

  it('a successful checkout delivers payment.captured then order.paid, each signed over its exact bytes with an event id', async () => {
    const order = await h.createOrder(50_000);
    const triple = await h.checkout(order.id, 'success', 'upi');
    await h.webhooks.idle();

    expect(receiver.received.map((r) => r.body.event)).toEqual(['payment.captured', 'order.paid']);
    for (const delivery of receiver.received) {
      expect(delivery.headers['content-type']).toBe('application/json');
      expect(delivery.headers['x-razorpay-event-id']).toMatch(/^evt_[A-Za-z0-9]{14}$/);
      const signature = delivery.headers['x-razorpay-signature'] as string;
      // payment-service's verifyWebhookSignature: HMAC_SHA256(raw body, webhook secret), constant time
      expect(verifyWebhookSignature(delivery.raw, signature)).toBe(true);
      expect(verifyWebhookSignature(JSON.stringify(delivery.body, null, 2), signature)).toBe(false);
      expect(verifyWebhookSignature(delivery.raw, signature, 'not-the-webhook-secret')).toBe(false);
      expect(delivery.body).toMatchObject({ entity: 'event', account_id: expect.stringMatching(/^acc_/), created_at: expect.any(Number) });
    }
    const [captured, paid] = receiver.received;
    expect(captured.body.contains).toEqual(['payment']);
    expect(captured.body.payload.payment.entity).toMatchObject({ id: triple.razorpay_payment_id, entity: 'payment', order_id: order.id, status: 'captured', amount: 50000 });
    expect(paid.body.contains).toEqual(['order', 'payment']);
    expect(paid.body.payload.order.entity).toMatchObject({ id: order.id, entity: 'order', status: 'paid', amount_paid: 50000 });
    expect(paid.body.payload.payment.entity).toMatchObject({ id: triple.razorpay_payment_id });
    expect(new Set(receiver.received.map((r) => r.headers['x-razorpay-event-id'])).size).toBe(2);
    expect(h.webhooks.deliveries.map((d) => [d.event, d.outcome, d.attempts, d.status])).toEqual([
      ['payment.captured', 'delivered', 1, 200],
      ['order.paid', 'delivered', 1, 200],
    ]);
  });

  it('a failed checkout delivers payment.failed; an authorized one payment.authorized; a capture through the API payment.captured + order.paid', async () => {
    const order = await h.createOrder();
    await h.checkout(order.id, 'failure', 'card');
    const authorized = await h.checkout(order.id, 'authorized', 'netbanking');
    await h.webhooks.idle();
    expect(receiver.received.map((r) => r.body.event)).toEqual(['payment.failed', 'payment.authorized']);
    expect(receiver.received[0].body.payload.payment.entity).toMatchObject({ status: 'failed', error_reason: 'payment_failed', order_id: order.id });
    expect(receiver.received[1].body.payload.payment.entity).toMatchObject({ id: authorized.razorpay_payment_id, status: 'authorized' });

    await h.api.post(`/v1/payments/${authorized.razorpay_payment_id}/capture`, { amount: 50_000, currency: 'INR' });
    await h.webhooks.idle();
    expect(receiver.received.slice(2).map((r) => r.body.event)).toEqual(['payment.captured', 'order.paid']);
  });

  it('a refund through the API delivers refund.processed with the refund and the payment', async () => {
    const order = await h.createOrder(50_000);
    const { razorpay_payment_id: paymentId } = await h.checkout(order.id);
    const refund = await h.api.post(`/v1/payments/${paymentId}/refund`, { amount: 50_000, receipt: 'refund-1', notes: { refundId: 'refund-1' } });
    await h.webhooks.idle();
    const event = receiver.received.find((r) => r.body.event === 'refund.processed')!;
    expect(event).toBeDefined();
    expect(event.body.contains).toEqual(['refund', 'payment']);
    expect(event.body.payload.refund.entity).toMatchObject({ id: refund.body.id, entity: 'refund', status: 'processed', payment_id: paymentId, notes: { refundId: 'refund-1' } });
    expect(event.body.payload.payment.entity).toMatchObject({ id: paymentId, status: 'refunded', amount_refunded: 50000 });
    expect(verifyWebhookSignature(event.raw, event.headers['x-razorpay-signature'] as string)).toBe(true);
  });

  it('retries on 5xx with the same event id, so the receiver can dedupe', async () => {
    receiver.script.push(500, 503);
    const order = await h.createOrder();
    await h.checkout(order.id, 'failure');
    await h.webhooks.idle();
    expect(receiver.received).toHaveLength(3);
    expect(new Set(receiver.received.map((r) => r.headers['x-razorpay-event-id'])).size).toBe(1);
    expect(new Set(receiver.received.map((r) => r.raw)).size).toBe(1);
    expect(h.webhooks.deliveries[0]).toMatchObject({ event: 'payment.failed', outcome: 'delivered', attempts: 3, status: 200 });
  });

  it('does not retry a 4xx: the receiver has decided (bad signature, duplicate, not ours)', async () => {
    receiver.script.push(400);
    const order = await h.createOrder();
    await h.checkout(order.id, 'failure');
    await h.webhooks.idle();
    expect(receiver.received).toHaveLength(1);
    expect(h.webhooks.deliveries[0]).toMatchObject({ outcome: 'rejected', attempts: 1, status: 400 });
  });

  it('gives up after the retries when the receiver keeps failing or is unreachable', async () => {
    receiver.script.push(500, 500, 500);
    const order = await h.createOrder();
    await h.checkout(order.id, 'failure');
    await h.webhooks.idle();
    expect(receiver.received).toHaveLength(3);
    expect(h.webhooks.deliveries[0]).toMatchObject({ outcome: 'failed', attempts: 3, status: 500 });

    const gone = await startReceiver();
    await gone.close();
    const unreachable = buildHarness({ config: { webhookUrl: gone.url } });
    const other = await unreachable.createOrder();
    await unreachable.checkout(other.id, 'failure');
    await unreachable.webhooks.idle();
    expect(unreachable.webhooks.deliveries[0]).toMatchObject({ outcome: 'failed', attempts: 3, status: null });
  });

  it('the API answer never waits for the delivery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async () => {
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const dispatcher = new WebhookDispatcher({ url: 'http://payment-service.invalid/webhook', secret: WEBHOOK_SECRET, fetchImpl: slow, retryDelaysMs: [] });
    const eventId = dispatcher.send('payment.failed', { payment: { entity: { id: 'pay_1' } } });
    expect(eventId).toMatch(/^evt_/);
    expect(dispatcher.deliveries[0]).toMatchObject({ eventId, event: 'payment.failed', outcome: 'skipped' });
    release();
    await dispatcher.idle();
    expect(dispatcher.deliveries[0].outcome).toBe('delivered');
  });

  it('without SIM_WEBHOOK_URL events are recorded and dropped', async () => {
    const quiet = buildHarness();
    const order = await quiet.createOrder();
    await quiet.checkout(order.id);
    await quiet.webhooks.idle();
    expect(quiet.webhooks.deliveries.map((d) => [d.event, d.outcome])).toEqual([
      ['payment.captured', 'skipped'],
      ['order.paid', 'skipped'],
    ]);
  });
});
