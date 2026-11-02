import { buildHarness, Harness } from './support/harness';

describe('refunds: POST /v1/payments/:id/refund, GET /v1/refunds/:id, GET /v1/payments/:id/refunds', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('refunds a captured payment in full: a processed refund, the payment refunded', async () => {
    const order = await h.createOrder(50_000);
    const { razorpay_payment_id: paymentId } = await h.checkout(order.id);
    const res = await h.api.post(`/v1/payments/${paymentId}/refund`, {
      amount: 50_000,
      speed: 'normal',
      receipt: 'refund-1',
      notes: { topUpId: 'topup-1', refundId: 'refund-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^rfnd_[A-Za-z0-9]{14}$/),
      entity: 'refund',
      amount: 50000,
      currency: 'INR',
      payment_id: paymentId,
      notes: { topUpId: 'topup-1', refundId: 'refund-1' },
      receipt: 'refund-1',
      acquirer_data: {},
      created_at: Math.floor(h.clock.now.getTime() / 1000),
      batch_id: null,
      status: 'processed',
      speed_processed: 'normal',
      speed_requested: 'normal',
    });
    expect((await h.api.get(`/v1/payments/${paymentId}`)).body).toMatchObject({ status: 'refunded', amount_refunded: 50000, refund_status: 'full' });
    expect((await h.api.get(`/v1/refunds/${res.body.id}`)).body).toEqual(res.body);
    const list = await h.api.get(`/v1/payments/${paymentId}/refunds`);
    expect(list.body).toEqual({ entity: 'collection', count: 1, items: [res.body] });
  });

  it('refunds partially (amount omitted means the rest), never more than was captured', async () => {
    const order = await h.createOrder(50_000);
    const { razorpay_payment_id: paymentId } = await h.checkout(order.id);
    const partial = await h.api.post(`/v1/payments/${paymentId}/refund`, { amount: 20_000 });
    expect(partial.status).toBe(200);
    expect((await h.api.get(`/v1/payments/${paymentId}`)).body).toMatchObject({ status: 'captured', amount_refunded: 20000, refund_status: 'partial' });

    const tooMuch = await h.api.post(`/v1/payments/${paymentId}/refund`, { amount: 30_001 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', reason: 'input_validation_failed', field: 'amount' });

    const rest = await h.api.post(`/v1/payments/${paymentId}/refund`, {});
    expect(rest.body.amount).toBe(30000);
    expect((await h.api.get(`/v1/payments/${paymentId}`)).body).toMatchObject({ status: 'refunded', amount_refunded: 50000, refund_status: 'full' });
    expect((await h.api.post(`/v1/payments/${paymentId}/refund`, {})).status).toBe(400);
    expect((await h.api.get(`/v1/payments/${paymentId}/refunds`)).body.count).toBe(2);
  });

  it('refuses to refund a payment that was not captured (failed or only authorized)', async () => {
    const order = await h.createOrder();
    const failed = await h.checkout(order.id, 'failure');
    const res = await h.api.post(`/v1/payments/${failed.razorpay_payment_id}/refund`, { amount: 50_000 });
    expect(res.status).toBe(400);
    expect(res.body.error.description).toBe('The payment has not been captured');
    const authorized = await h.checkout(order.id, 'authorized');
    expect((await h.api.post(`/v1/payments/${authorized.razorpay_payment_id}/refund`, {})).status).toBe(400);
    expect(h.store.refunds.size).toBe(0);
  });

  it('answers 400 "does not exist" for unknown payments and refunds', async () => {
    expect((await h.api.post('/v1/payments/pay_Unknown00000001/refund', { amount: 100 })).status).toBe(400);
    expect((await h.api.get('/v1/refunds/rfnd_Unknown0000001')).status).toBe(400);
    expect((await h.api.get('/v1/payments/pay_Unknown00000001/refunds')).status).toBe(400);
  });
});
