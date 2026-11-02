import crypto from 'crypto';
import { buildHarness, Harness, users } from './support/harness';

const key = () => `key-${crypto.randomUUID()}`;

describe('POST /top-ups', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('creates a Razorpay order and returns the top-up with the Checkout details', async () => {
    const res = await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '50000' }, { 'idempotency-key': key() });
    expect(res.status).toBe(201);
    const { topUp, checkout } = res.body.data;
    expect(topUp).toMatchObject({ status: 'CREATED', amountPaise: '50000', currency: 'INR', accountNumberLast4: '4321', providerPaymentId: null });
    expect(topUp).not.toHaveProperty('customerId');
    expect(topUp).not.toHaveProperty('idempotencyKey');
    expect(checkout).toEqual({
      keyId: 'rzp_test_UnitTest01',
      orderId: topUp.providerOrderId,
      amount: '50000',
      currency: 'INR',
      name: 'BankSphere',
      description: 'Add money to account ••4321',
      prefill: { email: 'alice@example.com' },
    });
    // receipt = top-up id, notes = top-up id and the account's last 4 digits
    const order = h.razorpay.orders.get(topUp.providerOrderId)!;
    expect(order).toMatchObject({ amount: 50000, receipt: topUp.id, notes: { topUpId: topUp.id, accountLast4: '4321' } });
    expect(new Date(topUp.expiresAt).getTime() - new Date(topUp.createdAt).getTime()).toBe(30 * 60_000);
    // the creation is a status change too: history row and payment.updated.v1 keyed by customer
    expect(h.statuses(topUp.id)).toEqual(['CREATED']);
    expect(h.store.outbox[0]).toMatchObject({
      aggregateId: users.alice.id,
      eventType: 'payment.updated.v1',
      payload: { topUpId: topUp.id, customerId: users.alice.id, amountInPaise: '50000', status: 'CREATED', previousStatus: null },
    });
  });

  it('requires an Idempotency-Key', async () => {
    const body = { accountId: h.aliceAccount.accountId, amountPaise: '50000' };
    expect((await h.api.post('/top-ups', users.alice, body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await h.api.post('/top-ups', users.alice, body, { 'idempotency-key': 'short' })).status).toBe(400);
    expect(h.razorpay.count('createOrder')).toBe(0);
  });

  it('replays the same key with the same body, and refuses the same key with a different body (409)', async () => {
    const k = key();
    const body = { accountId: h.aliceAccount.accountId, amountPaise: '50000' };
    const first = await h.api.post('/top-ups', users.alice, body, { 'idempotency-key': k });
    const again = await h.api.post('/top-ups', users.alice, body, { 'idempotency-key': k });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data).toEqual(first.body.data);
    expect(h.razorpay.count('createOrder')).toBe(1);

    const different = await h.api.post('/top-ups', users.alice, { ...body, amountPaise: '60000' }, { 'idempotency-key': k });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(h.store.rows.size).toBe(1);
  });

  it('scopes keys per customer: the same key from another customer is a separate request', async () => {
    const k = key();
    await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '50000' }, { 'idempotency-key': k });
    const bob = await h.api.post('/top-ups', users.bob, { accountId: h.bobAccount.accountId, amountPaise: '50000' }, { 'idempotency-key': k });
    expect(bob.status).toBe(201);
    expect(h.store.rows.size).toBe(2);
  });

  it('turns concurrent duplicates with one key into one top-up', async () => {
    const k = key();
    const body = { accountId: h.aliceAccount.accountId, amountPaise: '50000' };
    const results = await Promise.all([1, 2, 3].map(() => h.api.post('/top-ups', users.alice, body, { 'idempotency-key': k })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.data.topUp.id)).size).toBe(1);
    expect(h.store.rows.size).toBe(1);
  });

  it('validates the amount: digits only, within min and max', async () => {
    const post = (amountPaise: unknown) =>
      h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise }, { 'idempotency-key': key() });
    for (const bad of [50000, '0', '-100', '12.50', '1e5', '', '0100']) {
      expect((await post(bad)).body.error.code).toBe('INVALID_AMOUNT');
    }
    expect((await post('99')).body.error.code).toBe('AMOUNT_TOO_SMALL');
    expect((await post('10000001')).body.error.code).toBe('AMOUNT_TOO_LARGE');
    expect((await post('100')).status).toBe(201);
    expect((await post('10000000')).status).toBe(201);
  });

  it('requires a VERIFIED KYC', async () => {
    for (const status of ['PENDING', 'REJECTED', 'NONE'] as const) {
      h.customers.kyc.set(users.alice.id, status);
      const res = await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '50000' }, { 'idempotency-key': key() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KYC_NOT_VERIFIED');
    }
    expect(h.razorpay.count('createOrder')).toBe(0);
  });

  it("only tops up the caller's own active account (another customer's account is 'not found')", async () => {
    const bobs = await h.api.post('/top-ups', users.alice, { accountId: h.bobAccount.accountId, amountPaise: '50000' }, { 'idempotency-key': key() });
    expect(bobs.status).toBe(404);
    expect(bobs.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const unknown = await h.api.post('/top-ups', users.alice, { accountId: crypto.randomUUID(), amountPaise: '50000' }, { 'idempotency-key': key() });
    expect(unknown.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const frozen = h.ledger.addAccount(users.alice.id, { isActive: false });
    const closed = h.ledger.addAccount(users.alice.id, { closed: true });
    for (const account of [frozen, closed]) {
      const res = await h.api.post('/top-ups', users.alice, { accountId: account.accountId, amountPaise: '50000' }, { 'idempotency-key': key() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
    }
    expect(h.razorpay.count('createOrder')).toBe(0);
  });

  it('allows at most 3 open orders per customer; expired ones no longer count', async () => {
    for (let i = 0; i < 3; i++) await h.createTopUp(users.alice, '1000');
    const fourth = await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '1000' }, { 'idempotency-key': key() });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('TOO_MANY_OPEN_TOP_UPS');
    h.advance(31 * 60_000);
    expect((await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '1000' }, { 'idempotency-key': key() })).status).toBe(201);
  });

  it('cancelled and failed orders free their slot', async () => {
    const a = await h.createTopUp(users.alice, '1000');
    await h.createTopUp(users.alice, '1000');
    await h.createTopUp(users.alice, '1000');
    await h.api.post(`/top-ups/${a.id}/cancel`, users.alice);
    expect((await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '1000' }, { 'idempotency-key': key() })).status).toBe(201);
  });
});

describe('daily top-up limit (IST day)', () => {
  // 23:59:00 IST on 28 Oct = 18:29:00 UTC
  const lateEvening = new Date('2026-10-28T18:29:00.000Z');

  it('counts open, captured and credited top-ups of the IST day, and resets at IST midnight', async () => {
    const h = buildHarness({ start: lateEvening, config: { limits: { minPaise: 100n, maxPaise: 10_000_000n, dailyLimitPaise: 100_000n, maxOpenOrders: 3 } } });
    const credited = await h.createTopUp(users.alice, '60000');
    const pay = h.razorpay.pay(credited.providerOrderId, { status: 'captured' });
    expect((await h.api.post(`/top-ups/${credited.id}/confirm`, users.alice, h.proof(credited, pay.id))).body.data.topUp.status).toBe('CREDITED');
    await h.createTopUp(users.alice, '30000'); // open

    const config = await h.api.get('/config', users.alice);
    expect(config.body.data.limits).toEqual({
      minPaise: '100',
      maxPaise: '10000000',
      dailyLimitPaise: '100000',
      usedTodayPaise: '90000',
      remainingTodayPaise: '10000',
    });
    const over = await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '10001' }, { 'idempotency-key': key() });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('TOPUP_DAILY_LIMIT_EXCEEDED');
    expect((await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '10000' }, { 'idempotency-key': key() })).status).toBe(201);

    // 23:59:59.999 IST: still the same day
    h.clock.now = new Date('2026-10-28T18:29:59.999Z');
    expect((await h.api.get('/config', users.alice)).body.data.limits.remainingTodayPaise).toBe('0');
    // 00:00:00.000 IST on 29 Oct: a new day
    h.clock.now = new Date('2026-10-28T18:30:00.000Z');
    const fresh = await h.api.get('/config', users.alice);
    expect(fresh.body.data.limits).toMatchObject({ usedTodayPaise: '0', remainingTodayPaise: '100000' });
    expect((await h.api.post('/top-ups', users.alice, { accountId: h.aliceAccount.accountId, amountPaise: '100000' }, { 'idempotency-key': key() })).status).toBe(201);
  });

  it('does not count cancelled, failed, expired or refunded top-ups', async () => {
    const h = buildHarness({ config: { limits: { minPaise: 100n, maxPaise: 10_000_000n, dailyLimitPaise: 100_000n, maxOpenOrders: 3 } } });
    const t = await h.createTopUp(users.alice, '100000');
    await h.api.post(`/top-ups/${t.id}/cancel`, users.alice);
    expect((await h.api.get('/config', users.alice)).body.data.limits.usedTodayPaise).toBe('0');
  });

  it('reports the mode and public key id, never the secret', async () => {
    const h = buildHarness();
    const res = await h.api.get('/config', users.alice);
    expect(res.body.data).toMatchObject({ provider: 'RAZORPAY', mode: 'test', keyId: 'rzp_test_UnitTest01' });
    expect(JSON.stringify(res.body)).not.toContain(h.config.razorpay.keySecret);
  });
});

describe('POST /top-ups/:id/confirm', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('verifies the signature, fetches the payment from Razorpay and credits the ledger once', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured', method: 'card' });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.status).toBe(200);
    expect(res.body.data.topUp).toMatchObject({ status: 'CREDITED', providerPaymentId: pay.id, method: 'card' });
    expect(res.body.data.topUp.creditedAt).toBeTruthy();
    expect(h.razorpay.count('fetchPayment')).toBe(1);
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
    expect([...h.ledger.credits.keys()]).toEqual([t.id]); // idempotency key of the credit = the top-up id
    expect(h.statuses(t.id)).toEqual(['CREATED', 'CAPTURED', 'CREDITED']);
    expect(h.store.outbox.map((e) => [e.payload.previousStatus, e.payload.status])).toEqual([
      [null, 'CREATED'],
      ['CREATED', 'CAPTURED'],
      ['CAPTURED', 'CREDITED'],
    ]);

    // a retried confirm answers with the settled top-up and moves no money
    const again = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(again.body.data.topUp.status).toBe('CREDITED');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
  });

  it('refuses a tampered or wrong-length signature (400, security log) without calling Razorpay', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const good = h.proof(t, pay.id);
    for (const razorpaySignature of [good.razorpaySignature.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), good.razorpaySignature.slice(0, 40), 'x']) {
      const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, { ...good, razorpaySignature });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');
    }
    // a valid signature for ANOTHER payment id doesn't transfer
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, { ...good, razorpayPaymentId: 'pay_Someoneelse01' });
    expect(res.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');
    expect(h.razorpay.count('fetchPayment')).toBe(0);
    expect(h.ledger.creditCalls).toBe(0);
  });

  it("refuses another order's (validly signed) payment", async () => {
    const mine = await h.createTopUp();
    const other = await h.createTopUp(users.alice, '1000');
    const pay = h.razorpay.pay(other.providerOrderId, { status: 'captured' });
    const res = await h.api.post(`/top-ups/${mine.id}/confirm`, users.alice, h.proof(other, pay.id));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_ORDER_MISMATCH');
    expect(h.ledger.creditCalls).toBe(0);
  });

  it('never credits when the captured amount differs: CREDIT_BLOCKED, audited', async () => {
    const t = await h.createTopUp(users.alice, '50000');
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured', amount: 100 });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.status).toBe(200);
    expect(res.body.data.topUp).toMatchObject({ status: 'CREDIT_BLOCKED', failureReason: 'AMOUNT_MISMATCH' });
    expect(h.ledger.creditCalls).toBe(0);
    expect(h.statuses(t.id)).toEqual(['CREATED', 'CAPTURED', 'CREDIT_BLOCKED']);
    expect(h.store.audits).toEqual([
      expect.objectContaining({ action: 'PAYMENT_CREDIT_BLOCKED', targetId: t.id, details: expect.objectContaining({ reason: 'AMOUNT_MISMATCH', capturedAmountPaise: '100' }) }),
    ]);
    expect((await h.store.verifyAudit()).ok).toBe(true);
  });

  it('never credits a different currency', async () => {
    const t = await h.createTopUp(users.alice, '50000');
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured', currency: 'USD' });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.body.data.topUp.status).toBe('CREDIT_BLOCKED');
    expect(h.ledger.creditCalls).toBe(0);
  });

  it('captures an authorized payment (exact amount and currency), then credits', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'authorized' });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.body.data.topUp.status).toBe('CREDITED');
    expect(h.razorpay.payments.get(pay.id)!.status).toBe('captured');
    expect(h.statuses(t.id)).toEqual(['CREATED', 'PENDING', 'CAPTURED', 'CREDITED']);
  });

  it('does not capture an authorization for the wrong amount: FAILED, nothing taken', async () => {
    const t = await h.createTopUp(users.alice, '50000');
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'authorized', amount: 49_999 });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.body.data.topUp).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
    expect(h.razorpay.count('capturePayment')).toBe(0);
    expect(h.ledger.creditCalls).toBe(0);
  });

  it('answers 422 PAYMENT_NOT_CAPTURED for a failed payment and records FAILED', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'failed', errorReason: 'insufficient_funds' });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_NOT_CAPTURED');
    expect(h.store.get(t.id)).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
  });

  it('keeps a captured payment CAPTURED while the ledger is down; the reconciler credits it later', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.ledger.creditBehaviour = 'unavailable';
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.status).toBe(200);
    expect(res.body.data.topUp.status).toBe('CAPTURED');
    h.ledger.creditBehaviour = 'ok';
    h.advance(31_000);
    const report = await h.services.reconciler.runScheduled();
    expect(report!.changes).toEqual({ CREDITED: 1 });
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
  });

  it('ledger 409 (account closed or frozen since) -> CREDIT_BLOCKED, audited, money kept for a refund', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.ledger.accounts.get(h.aliceAccount.accountId)!.isActive = false;
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(res.body.data.topUp).toMatchObject({ status: 'CREDIT_BLOCKED', failureReason: 'ACCOUNT_NOT_CREDITABLE' });
    expect(h.store.audits.map((a) => a.action)).toEqual(['PAYMENT_CREDIT_BLOCKED']);
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(0n);
  });

  it('settles exactly once when confirm and the webhook race (one credit, one CREDITED)', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const [confirm1, hook, confirm2] = await Promise.all([
      h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id)),
      h.webhook('payment.captured', { payment: { entity: { id: pay.id, order_id: t.providerOrderId, entity: 'payment' } } }),
      h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id)),
    ]);
    expect([confirm1.status, hook.status, confirm2.status]).toEqual([200, 200, 200]);
    // They really raced: more than one path asked the ledger to credit; its idempotency on the top-up id held
    expect(h.ledger.creditCalls).toBeGreaterThan(1);
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.ledger.credits.size).toBe(1);
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
    expect(h.statuses(t.id).filter((s) => s === 'CREDITED')).toHaveLength(1);
    expect(h.statuses(t.id).filter((s) => s === 'CAPTURED')).toHaveLength(1);
    expect(h.store.outbox.filter((e) => e.payload.status === 'CREDITED')).toHaveLength(1);
  });

  it("is 404 for someone else's top-up", async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.bob, h.proof(t, pay.id));
    expect(res.status).toBe(404);
    expect(h.ledger.creditCalls).toBe(0);
  });
});

describe('POST /top-ups/:id/cancel and late captures', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('cancels CREATED and PENDING top-ups, idempotently; refuses anything else', async () => {
    const t = await h.createTopUp();
    const res = await h.api.post(`/top-ups/${t.id}/cancel`, users.alice);
    expect(res.body.data.topUp.status).toBe('CANCELLED');
    expect((await h.api.post(`/top-ups/${t.id}/cancel`, users.alice)).body.data.topUp.status).toBe('CANCELLED');
    expect(h.statuses(t.id)).toEqual(['CREATED', 'CANCELLED']);

    const pending = await h.createTopUp();
    h.store.seed({ ...h.store.get(pending.id), status: 'PENDING' });
    expect((await h.api.post(`/top-ups/${pending.id}/cancel`, users.alice)).body.data.topUp.status).toBe('CANCELLED');

    const paid = await h.createTopUp();
    const pay = h.razorpay.pay(paid.providerOrderId, { status: 'captured' });
    await h.api.post(`/top-ups/${paid.id}/confirm`, users.alice, h.proof(paid, pay.id));
    const refused = await h.api.post(`/top-ups/${paid.id}/cancel`, users.alice);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TOP_UP_NOT_CANCELLABLE');
    expect((await h.api.post(`/top-ups/${t.id}/cancel`, users.bob)).status).toBe(404);
  });

  it('a capture after the customer cancelled still credits (their money was taken)', async () => {
    const t = await h.createTopUp();
    await h.api.post(`/top-ups/${t.id}/cancel`, users.alice);
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const res = await h.webhook('payment.captured', { payment: { entity: { id: pay.id, order_id: t.providerOrderId } } });
    expect(res.status).toBe(200);
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.statuses(t.id)).toEqual(['CREATED', 'CANCELLED', 'CAPTURED', 'CREDITED']);
    expect(h.store.historyRows.find((r) => r.topUpId === t.id && r.to === 'CAPTURED')!.reason).toBe('LATE_CAPTURE');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
  });

  it('late captures credit FAILED and EXPIRED top-ups too', async () => {
    for (const status of ['FAILED', 'EXPIRED'] as const) {
      const t = await h.createTopUp(users.alice, '1000');
      h.store.seed({ ...h.store.get(t.id), status });
      const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
      await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
      expect(h.store.get(t.id).status).toBe('CREDITED');
    }
  });
});

describe('POST /top-ups/:id/simulate', () => {
  it('is 404 unless the service runs in simulator mode', async () => {
    const h = buildHarness();
    const t = await h.createTopUp();
    const res = await h.api.post(`/top-ups/${t.id}/simulate`, users.alice, { outcome: 'success', method: 'upi' });
    expect(res.status).toBe(404);
    expect(h.razorpay.count('simulateCheckout')).toBe(0);
  });

  it('is 404 when NODE_ENV=production even if simulator mode were enabled', async () => {
    const h = buildHarness({ config: { mode: 'simulator', simulateEnabled: true } });
    const t = await h.createTopUp();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect((await h.api.post(`/top-ups/${t.id}/simulate`, users.alice, { outcome: 'success', method: 'upi' })).status).toBe(404);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('returns the signed triple Checkout.js would hand the browser, which confirm then settles', async () => {
    const h = buildHarness({ config: { mode: 'simulator', simulateEnabled: true } });
    const t = await h.createTopUp();
    const sim = await h.api.post(`/top-ups/${t.id}/simulate`, users.alice, { outcome: 'success', method: 'card' });
    expect(sim.status).toBe(200);
    const triple = sim.body.data;
    expect(Object.keys(triple).sort()).toEqual(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']);
    const confirm = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, {
      razorpayPaymentId: triple.razorpay_payment_id,
      razorpayOrderId: triple.razorpay_order_id,
      razorpaySignature: triple.razorpay_signature,
    });
    expect(confirm.body.data.topUp).toMatchObject({ status: 'CREDITED', method: 'card' });
    expect((await h.api.post(`/top-ups/${t.id}/simulate`, users.bob, { outcome: 'success', method: 'upi' })).status).toBe(404);
    expect((await h.api.post(`/top-ups/${t.id}/simulate`, users.alice, { outcome: 'maybe', method: 'upi' })).status).toBe(400);
  });

  it('a simulated failure is refused by confirm with PAYMENT_NOT_CAPTURED', async () => {
    const h = buildHarness({ config: { mode: 'simulator', simulateEnabled: true } });
    const t = await h.createTopUp();
    const triple = (await h.api.post(`/top-ups/${t.id}/simulate`, users.alice, { outcome: 'failure', method: 'upi' })).body.data;
    const confirm = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, {
      razorpayPaymentId: triple.razorpay_payment_id,
      razorpayOrderId: triple.razorpay_order_id,
      razorpaySignature: triple.razorpay_signature,
    });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe('PAYMENT_NOT_CAPTURED');
    expect(h.store.get(t.id).status).toBe('FAILED');
  });
});

describe('reading top-ups', () => {
  it('lists own top-ups newest first with a cursor, and never anyone else\'s', async () => {
    const h = buildHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await h.createTopUp(users.alice, String(1000 + i))).id);
      h.advance(1000);
      if (i < 2) await h.api.post(`/top-ups/${ids[i]}/cancel`, users.alice);
    }
    await h.createTopUp(users.bob, '5000', h.bobAccount.accountId);
    const first = await h.api.get('/top-ups?limit=3', users.alice);
    expect(first.body.data.items.map((t: { id: string }) => t.id)).toEqual([ids[4], ids[3], ids[2]]);
    const second = await h.api.get(`/top-ups?limit=3&cursor=${first.body.data.nextCursor}`, users.alice);
    expect(second.body.data.items.map((t: { id: string }) => t.id)).toEqual([ids[1], ids[0]]);
    expect(second.body.data.nextCursor).toBeNull();
    expect((await h.api.get('/top-ups?cursor=!!!', users.alice)).status).toBe(400);
    expect((await h.api.get('/top-ups?limit=500', users.alice)).status).toBe(400);
  });

  it('shows one top-up with its history to the owner and to staff, 404 to other customers', async () => {
    const h = buildHarness();
    const t = await h.createTopUp();
    await h.api.post(`/top-ups/${t.id}/cancel`, users.alice);
    const own = await h.api.get(`/top-ups/${t.id}`, users.alice);
    expect(own.body.data.topUp.history.map((x: { to: string }) => x.to)).toEqual(['CREATED', 'CANCELLED']);
    expect(own.body.data.topUp.history[1]).toMatchObject({ from: 'CREATED', to: 'CANCELLED', source: 'customer' });
    expect(own.body.data.topUp).not.toHaveProperty('customerId');
    for (const staff of [users.support, users.fraud, users.admin]) {
      const res = await h.api.get(`/top-ups/${t.id}`, staff);
      expect(res.status).toBe(200);
      expect(res.body.data.topUp.customerId).toBe(users.alice.id);
    }
    expect((await h.api.get(`/top-ups/${t.id}`, users.bob)).status).toBe(404);
    expect((await h.api.get(`/top-ups/${t.id}`, users.teller)).status).toBe(403);
    expect((await h.api.get('/top-ups/not-a-uuid', users.alice)).status).toBe(404);
  });
});
