import { buildHarness, Harness, KEY_SECRET, sign, verifyPaymentSignature } from './support/harness';

describe('POST /sim/checkout/:orderId', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('success: captures a payment, marks the order paid and returns the signed triple Checkout.js would', async () => {
    const order = await h.createOrder(50_000);
    const res = await h.api.post(`/sim/checkout/${order.id}`, { outcome: 'success', method: 'upi' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = res.body;
    expect(razorpay_order_id).toBe(order.id);
    expect(razorpay_payment_id).toMatch(/^pay_[A-Za-z0-9]{14}$/);
    // exactly what payment-service's verifyPaymentSignature computes
    expect(razorpay_signature).toBe(sign(KEY_SECRET, `${order.id}|${razorpay_payment_id}`));
    expect(verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)).toBe(true);
    expect(verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, 'another-secret')).toBe(false);

    const payment = (await h.api.get(`/v1/payments/${razorpay_payment_id}`)).body;
    expect(payment).toMatchObject({
      id: razorpay_payment_id,
      entity: 'payment',
      amount: 50000,
      currency: 'INR',
      status: 'captured',
      captured: true,
      order_id: order.id,
      method: 'upi',
      vpa: 'success@razorpay',
      amount_refunded: 0,
      refund_status: null,
      error_code: null,
      error_reason: null,
      notes: {},
    });
    expect(typeof payment.created_at).toBe('number');
    expect((await h.api.get(`/v1/orders/${order.id}`)).body).toMatchObject({ status: 'paid', amount_paid: 50000, amount_due: 0, attempts: 1 });
  });

  it('failure: records a failed payment with Razorpay\'s error fields, the order stays attempted, the triple is still returned', async () => {
    const order = await h.createOrder(20_000);
    const res = await h.api.post(`/sim/checkout/${order.id}`, { outcome: 'failure', method: 'card' });
    expect(res.status).toBe(200);
    expect(verifyPaymentSignature(order.id, res.body.razorpay_payment_id, res.body.razorpay_signature)).toBe(true);
    const payment = (await h.api.get(`/v1/payments/${res.body.razorpay_payment_id}`)).body;
    expect(payment).toMatchObject({
      status: 'failed',
      captured: false,
      method: 'card',
      card_id: expect.stringMatching(/^card_/),
      error_code: 'BAD_REQUEST_ERROR',
      error_description: expect.any(String),
      error_source: 'customer',
      error_step: 'payment_authentication',
      error_reason: 'payment_failed',
    });
    expect((await h.api.get(`/v1/orders/${order.id}`)).body).toMatchObject({ status: 'attempted', amount_paid: 0, amount_due: 20000, attempts: 1 });
    // the customer may try again on the same order
    await h.checkout(order.id, 'success', 'netbanking');
    expect((await h.api.get(`/v1/orders/${order.id}`)).body).toMatchObject({ status: 'paid', attempts: 2 });
  });

  it('authorized: leaves the payment for the merchant to capture through the API', async () => {
    const order = await h.createOrder(50_000);
    const triple = await h.checkout(order.id, 'authorized', 'netbanking');
    const paymentId = triple.razorpay_payment_id;
    expect((await h.api.get(`/v1/payments/${paymentId}`)).body).toMatchObject({ status: 'authorized', captured: false, bank: 'HDFC' });
    expect((await h.api.get(`/v1/orders/${order.id}`)).body.status).toBe('attempted');

    const wrong = await h.api.post(`/v1/payments/${paymentId}/capture`, { amount: 49_999, currency: 'INR' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', description: 'Capture amount must be equal to the amount authorized' });
    expect((await h.api.post(`/v1/payments/${paymentId}/capture`, { amount: 50_000, currency: 'USD' })).status).toBe(400);

    const captured = await h.api.post(`/v1/payments/${paymentId}/capture`, { amount: 50_000, currency: 'INR' });
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ id: paymentId, status: 'captured', captured: true, amount: 50000 });
    expect((await h.api.get(`/v1/orders/${order.id}`)).body).toMatchObject({ status: 'paid', amount_paid: 50000 });

    const again = await h.api.post(`/v1/payments/${paymentId}/capture`, { amount: 50_000, currency: 'INR' });
    expect(again.status).toBe(400);
    expect(again.body.error.description).toBe('This payment has already been captured');
  });

  it('cannot capture a failed payment, and validates the capture body', async () => {
    const order = await h.createOrder();
    const failed = await h.checkout(order.id, 'failure');
    const res = await h.api.post(`/v1/payments/${failed.razorpay_payment_id}/capture`, { amount: 50_000, currency: 'INR' });
    expect(res.status).toBe(400);
    expect(res.body.error.description).toBe('This payment has not been authorized');
    expect((await h.api.post(`/v1/payments/${failed.razorpay_payment_id}/capture`, { amount: '50000' })).status).toBe(400);
    expect((await h.api.post('/v1/payments/pay_Unknown00000001/capture', { amount: 50_000, currency: 'INR' })).status).toBe(400);
  });

  it('refuses to pay an order again once it is paid (Razorpay takes one successful payment per order)', async () => {
    const order = await h.createOrder();
    await h.checkout(order.id, 'success');
    const res = await h.api.post(`/sim/checkout/${order.id}`, { outcome: 'success', method: 'upi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', description: 'Order has already been paid' });
    expect(h.store.payments.size).toBe(1);
  });

  it('validates the body and the order id', async () => {
    const order = await h.createOrder();
    for (const body of [{ outcome: 'maybe', method: 'upi' }, { outcome: 'success', method: 'cash' }, { outcome: 'success' }, {}]) {
      const res = await h.api.post(`/sim/checkout/${order.id}`, body);
      expect([body, res.status]).toEqual([body, 400]);
      expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', reason: 'input_validation_failed' });
    }
    const unknown = await h.api.post('/sim/checkout/order_Unknown0000001', { outcome: 'success', method: 'upi' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.description).toBe('The id provided does not exist');
    expect(h.store.payments.size).toBe(0);
  });

  it('every payment gets its own id and signature; signatures never transfer between payments or orders', async () => {
    const a = await h.createOrder();
    const b = await h.createOrder();
    const payA = await h.checkout(a.id);
    const payB = await h.checkout(b.id);
    expect(payA.razorpay_payment_id).not.toBe(payB.razorpay_payment_id);
    expect(verifyPaymentSignature(a.id, payB.razorpay_payment_id, payA.razorpay_signature)).toBe(false);
    expect(verifyPaymentSignature(b.id, payA.razorpay_payment_id, payA.razorpay_signature)).toBe(false);
  });
});
