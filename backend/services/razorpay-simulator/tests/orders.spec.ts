import { buildHarness, Harness } from './support/harness';

describe('orders: POST /v1/orders, GET /v1/orders/:id, GET /v1/orders/:id/payments', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('creates an order shaped like Razorpay\'s (id order_…, amounts in paise as numbers, epoch seconds)', async () => {
    const res = await h.api.post('/v1/orders', { amount: 50000, currency: 'INR', receipt: 'c1c6c2c3-0000-4000-8000-000000000001', notes: { topUpId: 't1', accountLast4: '4321' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^order_[A-Za-z0-9]{14}$/),
      entity: 'order',
      amount: 50000,
      amount_paid: 0,
      amount_due: 50000,
      currency: 'INR',
      receipt: 'c1c6c2c3-0000-4000-8000-000000000001',
      offer_id: null,
      status: 'created',
      attempts: 0,
      notes: { topUpId: 't1', accountLast4: '4321' },
      created_at: Math.floor(h.clock.now.getTime() / 1000),
    });
    expect(typeof res.body.amount).toBe('number');
    expect(typeof res.body.created_at).toBe('number');
  });

  it('defaults the currency to INR and the receipt and notes to empty', async () => {
    const res = await h.api.post('/v1/orders', { amount: 100 });
    expect(res.body).toMatchObject({ currency: 'INR', receipt: null, notes: {} });
  });

  it('validates the way Razorpay does: whole paise from INR 1.00, 3-letter currency, bounded receipt and notes', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amount: 99 }, 'amount'],
      [{ amount: 500.5 }, 'amount'],
      [{ amount: '50000' }, 'amount'],
      [{ amount: 50000, currency: 'rupees' }, 'currency'],
      [{ amount: 50000, receipt: 'r'.repeat(41) }, 'receipt'],
      [{ amount: 50000, notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }, 'notes'],
      [{ amount: 50000, notes: { a: 1 } }, 'notes.a'],
    ];
    for (const [body, field] of cases) {
      const res = await h.api.post('/v1/orders', body);
      expect([body, res.status]).toEqual([body, 400]);
      expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', reason: 'input_validation_failed', field });
    }
    expect((await h.api.post('/v1/orders', { amount: 99 })).body.error.description).toMatch(/minimum amount/);
    expect(h.store.orders.size).toBe(0);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await h.api.post('/v1/orders').set('content-type', 'application/json').send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR' });
  });

  it('fetches an order by id and answers 400 "does not exist" for unknown or malformed ids', async () => {
    const order = await h.createOrder();
    expect((await h.api.get(`/v1/orders/${order.id}`)).body).toMatchObject({ id: order.id, status: 'created' });
    for (const id of ['order_Unknown0000001', 'not-an-order-id', 'order_%2e%2e']) {
      const res = await h.api.get(`/v1/orders/${id}`);
      expect([id, res.status]).toEqual([id, 400]);
      expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' });
    }
  });

  it('lists an order\'s payments as a collection, empty until someone pays', async () => {
    const order = await h.createOrder();
    expect((await h.api.get(`/v1/orders/${order.id}/payments`)).body).toEqual({ entity: 'collection', count: 0, items: [] });
    await h.checkout(order.id, 'failure', 'card');
    await h.checkout(order.id, 'success', 'upi');
    const res = await h.api.get(`/v1/orders/${order.id}/payments`);
    expect(res.body.count).toBe(2);
    expect(res.body.items.map((p: { status: string; order_id: string }) => [p.status, p.order_id])).toEqual([
      ['failed', order.id],
      ['captured', order.id],
    ]);
    expect((await h.api.get('/v1/orders/order_Unknown0000001/payments')).status).toBe(400);
  });

  it('answers unknown routes with a Razorpay-shaped error', async () => {
    const res = await h.api.get('/v1/customers/cust_1');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST_ERROR', description: expect.stringMatching(/not found/) });
  });
});
