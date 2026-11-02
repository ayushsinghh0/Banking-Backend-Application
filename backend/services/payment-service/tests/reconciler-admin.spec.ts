import './support/env';
import { buildHarness, Harness, users } from './support/harness';

const MINUTE = 60_000;

describe('reconciler (design section 6, every 60 s under a job lease)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('leaves young open orders alone, then expires unpaid ones after TOPUP_ORDER_TTL_MINUTES', async () => {
    const t = await h.createTopUp();
    h.advance(MINUTE);
    expect((await h.services.reconciler.runScheduled())!.checked.open).toBe(0);
    expect(h.razorpay.count('fetchOrderPayments')).toBe(0);

    h.advance(5 * MINUTE);
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({});
    expect(h.store.get(t.id).status).toBe('CREATED');

    h.advance(30 * MINUTE);
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({ EXPIRED: 1 });
    expect(h.store.get(t.id)).toMatchObject({ status: 'EXPIRED', failureReason: 'ORDER_EXPIRED' });
    expect(h.store.history(t.id)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ to: 'EXPIRED', source: 'reconciler' })]));
  });

  it('settles an order paid while the browser and the webhook were both lost (authorized: captured, then credited)', async () => {
    const t = await h.createTopUp();
    h.razorpay.pay(t.providerOrderId, { status: 'authorized' });
    h.advance(3 * MINUTE);
    const report = await h.services.reconciler.runScheduled();
    expect(report!.changes).toEqual({ CREDITED: 1 });
    expect(h.razorpay.count('capturePayment')).toBe(1);
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
  });

  it('marks an order whose only payment failed as FAILED', async () => {
    const t = await h.createTopUp();
    h.razorpay.pay(t.providerOrderId, { status: 'failed', errorReason: 'payment_declined' });
    h.advance(3 * MINUTE);
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({ FAILED: 1 });
    expect(h.ledger.creditCalls).toBe(0);
  });

  it('keeps going when one top-up fails: counts the error and retries it on the next run', async () => {
    const a = await h.createTopUp();
    const b = await h.createTopUp();
    h.razorpay.pay(a.providerOrderId, { status: 'captured' });
    h.razorpay.pay(b.providerOrderId, { status: 'captured' });
    h.advance(3 * MINUTE);
    h.razorpay.down.add('fetchOrderPayments');
    const failed = await h.services.reconciler.runScheduled();
    expect([failed!.errors, failed!.changes]).toEqual([2, {}]);
    h.razorpay.down.clear();
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({ CREDITED: 2 });
  });

  it('a scheduled run audits itself only when it changed something', async () => {
    await h.services.reconciler.runScheduled();
    expect(h.store.audits).toHaveLength(0);
    await h.createTopUp();
    h.advance(40 * MINUTE);
    await h.services.reconciler.runScheduled();
    expect(h.store.audits.map((a) => [a.action, a.actorId])).toEqual([['PAYMENT_RECONCILE_RUN', 'system:reconciler']]);
  });

  it('runs once per replica at a time: concurrent manual runs get 409 RECONCILE_IN_PROGRESS', async () => {
    const [first, second] = await Promise.allSettled([h.services.reconciler.runNow(users.admin.id), h.services.reconciler.runNow(users.admin.id)]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const refused = [first, second].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ statusCode: 409, errorCode: 'RECONCILE_IN_PROGRESS' });
    // and the lease is released afterwards
    expect((await h.services.reconciler.runNow(users.admin.id)).trigger).toBe('manual');
  });
});

describe('POST /admin/reconcile', () => {
  it('BANK_ADMIN runs it now and gets the report; the run is audited with the administrator as actor', async () => {
    const h = buildHarness();
    const t = await h.createTopUp();
    h.advance(31 * MINUTE);
    const res = await h.api.post('/admin/reconcile', users.admin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trigger: 'manual', changes: { EXPIRED: 1 }, errors: 0, truncated: false });
    expect(h.store.get(t.id).status).toBe('EXPIRED');
    expect(h.store.audits.at(-1)).toMatchObject({ action: 'PAYMENT_RECONCILE_RUN', actorId: users.admin.id });
  });

  it('is refused to every other role', async () => {
    const h = buildHarness();
    for (const user of [users.alice, users.support, users.fraud, users.teller, users.kyc]) {
      expect([user.role, (await h.api.post('/admin/reconcile', user)).status]).toEqual([user.role, 403]);
    }
  });
});

describe('staff read side: GET /admin/top-ups and GET /admin/summary', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  async function creditedTopUp(user = users.alice, amountPaise = '50000', accountId = h.aliceAccount.accountId) {
    const t = await h.createTopUp(user, amountPaise, accountId);
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.advance(42_000);
    await h.api.post(`/top-ups/${t.id}/confirm`, user, h.proof(t, pay.id));
    return t;
  }

  it('lists every customer\'s top-ups for staff, filtered by status and customer; never for customers', async () => {
    await creditedTopUp();
    await creditedTopUp(users.bob, '70000', h.bobAccount.accountId);
    const open = await h.createTopUp(users.bob, '1000', h.bobAccount.accountId);

    for (const user of [users.support, users.fraud, users.admin]) {
      expect((await h.api.get('/admin/top-ups', user)).body.data.items).toHaveLength(3);
    }
    const credited = await h.api.get('/admin/top-ups?status=CREDITED', users.support);
    expect(credited.body.data.items.map((t: { amountPaise: string }) => t.amountPaise).sort()).toEqual(['50000', '70000']);
    const bobs = await h.api.get(`/admin/top-ups?customerId=${users.bob.id}&status=CREATED`, users.fraud);
    expect(bobs.body.data.items.map((t: { id: string }) => t.id)).toEqual([open.id]);

    expect((await h.api.get('/admin/top-ups?status=NOPE', users.admin)).status).toBe(400);
    for (const user of [users.alice, users.teller, users.kyc]) expect((await h.api.get('/admin/top-ups', user)).status).toBe(403);
  });

  it("summarises today's (IST) top-ups: counts and sums by status, success rate, median time to credit", async () => {
    await creditedTopUp(); // credited 42 s after creation
    await creditedTopUp(users.bob, '70000', h.bobAccount.accountId);
    const failed = await h.createTopUp();
    h.razorpay.pay(failed.providerOrderId, { status: 'failed' });
    await h.api.post(`/top-ups/${failed.id}/confirm`, users.alice, h.proof(failed, [...h.razorpay.payments.values()].at(-1)!.id));
    await h.createTopUp(); // still open: not finished, not in the success rate

    const res = await h.api.get('/admin/summary', users.support);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      day: '2026-10-28',
      total: { count: 4, amountPaise: '220000' },
      successRate: 0.6667,
      medianSecondsToCredit: 42,
    });
    expect(res.body.data.byStatus.CREDITED).toEqual({ count: 2, amountPaise: '120000' });
    expect(res.body.data.byStatus.FAILED).toEqual({ count: 1, amountPaise: '50000' });
    expect(res.body.data.byStatus.REFUNDED).toEqual({ count: 0, amountPaise: '0' });
    expect((await h.api.get('/admin/summary', users.alice)).status).toBe(403);
  });

  it('starts a new day at IST midnight', async () => {
    await creditedTopUp();
    h.clock.now = new Date('2026-10-28T18:30:00.000Z'); // 00:00 IST on the 29th
    const res = await h.api.get('/admin/summary', users.admin);
    expect(res.body.data).toMatchObject({ day: '2026-10-29', total: { count: 0, amountPaise: '0' }, successRate: null, medianSecondsToCredit: null });
  });
});
