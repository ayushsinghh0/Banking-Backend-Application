import { KEY_ID, KEY_SECRET, basic, buildHarness } from './support/harness';

describe('HTTP basic authentication on the key pair', () => {
  const h = buildHarness();

  it('refuses requests without credentials with Razorpay\'s 401 error shape', async () => {
    const res = await h.api.get('/v1/orders/order_Unknown0000001', null);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'BAD_REQUEST_ERROR', description: 'The api key/secret provided is invalid', source: 'NA', step: 'NA', reason: 'NA', metadata: {} },
    });
  });

  it('refuses a wrong secret, a wrong key id, a different scheme and malformed headers', async () => {
    for (const header of [
      basic(KEY_ID, 'not-the-secret'),
      basic('rzp_test_SomeoneElse01', KEY_SECRET),
      `Bearer ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
      'Basic',
      `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')} extra`,
      `Basic ${Buffer.from(KEY_ID).toString('base64')}`,
    ]) {
      expect((await h.api.post('/v1/orders', { amount: 50000, currency: 'INR' }, header)).status).toBe(401);
    }
    expect(h.store.orders.size).toBe(0);
  });

  it('accepts the key pair as Razorpay\'s client sends it, on the API and the checkout stand-in alike', async () => {
    const order = await h.api.post('/v1/orders', { amount: 50000, currency: 'INR' }, basic());
    expect(order.status).toBe(200);
    const paid = await h.api.post(`/sim/checkout/${order.body.id}`, { outcome: 'success', method: 'upi' }, basic());
    expect(paid.status).toBe(200);
    expect((await h.api.post(`/sim/checkout/${order.body.id}`, { outcome: 'success', method: 'upi' }, null)).status).toBe(401);
  });

  it('leaves the health endpoints open (the compose healthcheck has no credentials)', async () => {
    const health = await h.api.get('/health', null);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'UP', service: 'razorpay-simulator' });
    expect((await h.api.get('/health/live', null)).body).toEqual({ status: 'UP' });
  });
});
