import './support/env';
import { buildHarness, Harness, TestUser, users } from './support/harness';

const REASON = 'Customer reported a duplicate top-up';

/** A top-up paid by card and credited to Alice's account (balance 500.00) */
async function credited(h: Harness, amountPaise = '50000') {
  const t = await h.createTopUp(users.alice, amountPaise);
  const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured', method: 'card' });
  const res = await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
  expect(res.body.data.topUp.status).toBe('CREDITED');
  return { ...h.store.get(t.id), paymentId: pay.id };
}

const refund = (h: Harness, id: string, opts: { user?: TestUser; reason?: string; key?: string } = {}) =>
  h.api.post(`/admin/top-ups/${id}/refund`, opts.user ?? users.admin, { reason: opts.reason ?? REASON }, opts.key ? { 'idempotency-key': opts.key } : {});

describe('POST /admin/top-ups/:id/refund (refund saga)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('debits the ledger, refunds through Razorpay and ends REFUNDED, all audited and in the chain', async () => {
    const t = await credited(h);
    const res = await refund(h, t.id);
    expect(res.status).toBe(200);
    expect(res.body.data.topUp).toMatchObject({ status: 'REFUNDED', refundReason: REASON });
    expect(res.body.data.topUp.refundedAt).toBeTruthy();

    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(0n);
    const [refundId] = [...h.ledger.refundDebits.keys()];
    expect(h.store.get(t.id).refundId).toBe(refundId); // the ledger debit is idempotent on the refund id
    const [providerRefund] = [...h.razorpay.refunds.values()];
    expect(providerRefund).toMatchObject({ payment_id: t.paymentId, amount: 50_000, receipt: refundId, notes: { topUpId: t.id, refundId } });
    expect(h.statuses(t.id)).toEqual(['CREATED', 'CAPTURED', 'CREDITED', 'REFUND_PENDING', 'REFUNDED']);
    expect(h.store.audits.map((a) => a.action)).toEqual(['PAYMENT_REFUND_REQUESTED', 'PAYMENT_REFUNDED']);
    expect(h.store.audits[0]).toMatchObject({ actorId: users.admin.id, details: expect.objectContaining({ reason: REASON, ledgerDebit: true }) });
    expect((await h.store.verifyAudit()).ok).toBe(true);
    expect(h.store.outbox.at(-1)!.payload).toMatchObject({ status: 'REFUNDED', previousStatus: 'REFUND_PENDING' });
  });

  describe('who may refund', () => {
    it('BANK_ADMIN only, and only with a recent step-up on a factor older than a day', async () => {
      const t = await credited(h);
      for (const user of [users.support, users.fraud, users.teller, users.kyc, users.alice]) {
        expect([user.role, (await refund(h, t.id, { user })).status]).toEqual([user.role, 403]);
      }
      for (const user of [users.adminNoStepUp, users.adminStaleStepUp, users.adminNewFactor]) {
        const res = await refund(h, t.id, { user });
        expect([user.email, res.status, res.body.error.code]).toEqual([user.email, 403, 'STEP_UP_REQUIRED']);
      }
      expect(h.store.get(t.id).status).toBe('CREDITED');
      expect(h.ledger.refundCalls).toBe(0);
      expect(h.razorpay.count('refundPayment')).toBe(0);
    });

    it('needs a reason of 10 to 300 characters', async () => {
      const t = await credited(h);
      for (const reason of ['too short', 'x'.repeat(301), '          ']) expect((await refund(h, t.id, { reason })).status).toBe(400);
      expect(h.store.get(t.id).status).toBe('CREDITED');
    });
  });

  it('refuses top-ups that are not credited or blocked, and unknown ones', async () => {
    const open = await h.createTopUp();
    expect((await refund(h, open.id)).body.error.code).toBe('TOP_UP_NOT_REFUNDABLE');
    const t = await credited(h);
    expect((await refund(h, t.id)).status).toBe(200);
    const again = await refund(h, t.id);
    expect([again.status, again.body.error.code]).toEqual([409, 'TOP_UP_NOT_REFUNDABLE']);
    expect((await refund(h, '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01')).status).toBe(404);
    expect(h.razorpay.refunds.size).toBe(1);
  });

  it('a retry with the same Idempotency-Key answers with the refund it started instead of refusing', async () => {
    const t = await credited(h);
    const first = await refund(h, t.id, { key: 'refund-key-0001' });
    const retry = await refund(h, t.id, { key: 'refund-key-0001' });
    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.body.data.topUp).toMatchObject({ id: t.id, status: 'REFUNDED' });
    expect(h.ledger.refundCalls).toBe(1);
    expect(h.razorpay.refunds.size).toBe(1);
  });

  it("refuses when the customer's balance no longer covers it: back to CREDITED, nothing moved (409)", async () => {
    const t = await credited(h);
    h.ledger.accounts.get(h.aliceAccount.accountId)!.balance = 10_000n; // spent most of it
    const res = await refund(h, t.id);
    expect([res.status, res.body.error.code]).toEqual([409, 'INSUFFICIENT_FUNDS']);
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(10_000n);
    expect(h.razorpay.count('refundPayment')).toBe(0);
    expect(h.store.audits.at(-1)).toMatchObject({ action: 'PAYMENT_REFUND_FAILED', details: expect.objectContaining({ stage: 'ledger', code: 'INSUFFICIENT_FUNDS', compensated: false }) });
    // It can be refunded once the money is back
    h.ledger.accounts.get(h.aliceAccount.accountId)!.balance = 50_000n;
    expect((await refund(h, t.id)).body.data.topUp.status).toBe('REFUNDED');
  });

  it('Razorpay refuses: the ledger debit is reversed (compensation) and the top-up returns to CREDITED (409)', async () => {
    const t = await credited(h);
    h.razorpay.refundBehaviour = 'reject';
    const res = await refund(h, t.id);
    expect([res.status, res.body.error.code]).toEqual([409, 'REFUND_REJECTED']);
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
    const [refundId] = [...h.ledger.refundDebits.keys()];
    expect([...h.ledger.reversals.keys()]).toEqual([refundId]);
    expect(h.store.audits.at(-1)).toMatchObject({ action: 'PAYMENT_REFUND_FAILED', details: expect.objectContaining({ stage: 'provider', compensated: true }) });
    expect(h.statuses(t.id).slice(-2)).toEqual(['REFUND_PENDING', 'CREDITED']);
  });

  it('pending at Razorpay: 202, then the refund.processed webhook finishes it', async () => {
    const t = await credited(h);
    h.razorpay.refundBehaviour = 'pending';
    const res = await refund(h, t.id);
    expect([res.status, res.body.data.topUp.status]).toEqual([202, 'REFUND_PENDING']);
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(0n);

    const providerRefund = [...h.razorpay.refunds.values()][0];
    providerRefund.status = 'processed';
    const hook = await h.webhook('refund.processed', { refund: { entity: { ...providerRefund } } });
    expect(hook.status).toBe(200);
    expect(h.store.get(t.id).status).toBe('REFUNDED');
    expect((await h.store.history(t.id)).at(-1)).toMatchObject({ to: 'REFUNDED', source: 'webhook' });
  });

  it('a refund Razorpay later fails is compensated by the reconciler', async () => {
    const t = await credited(h);
    h.razorpay.refundBehaviour = 'pending';
    await refund(h, t.id);
    [...h.razorpay.refunds.values()][0].status = 'failed';
    h.advance(61_000);
    const report = await h.services.reconciler.runScheduled();
    expect(report!.changes).toEqual({ CREDITED: 1 });
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(50_000n);
  });

  it('a dependency outage leaves REFUND_PENDING (202); the reconciler resumes from where it stopped', async () => {
    const t = await credited(h);
    h.ledger.refundBehaviour = 'unavailable';
    expect((await refund(h, t.id)).status).toBe(202);
    h.ledger.refundBehaviour = 'ok';
    h.razorpay.refundBehaviour = 'unavailable';
    h.advance(61_000);
    await h.services.reconciler.runScheduled();
    expect(h.store.get(t.id)).toMatchObject({ status: 'REFUND_PENDING' });
    expect(h.ledger.balance(h.aliceAccount.accountId)).toBe(0n); // debited once, now waiting on Razorpay

    h.razorpay.refundBehaviour = 'processed';
    h.advance(61_000);
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({ REFUNDED: 1 });
    expect(h.ledger.refundDebits.size).toBe(1);
    expect(h.razorpay.refunds.size).toBe(1);
  });

  it('Razorpay refunded but its answer was lost: the retry finds that refund instead of refunding twice', async () => {
    const t = await credited(h);
    h.razorpay.refundBehaviour = 'timeout_after_create';
    expect((await refund(h, t.id)).status).toBe(202);
    h.razorpay.refundBehaviour = 'processed';
    h.advance(61_000);
    expect((await h.services.reconciler.runScheduled())!.changes).toEqual({ REFUNDED: 1 });
    expect(h.razorpay.refunds.size).toBe(1);
    expect(h.store.get(t.id).providerRefundId).toBe([...h.razorpay.refunds.keys()][0]);
  });

  it('a CREDIT_BLOCKED top-up is refunded without a ledger debit (it was never credited)', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.ledger.accounts.get(h.aliceAccount.accountId)!.closed = true;
    await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    expect(h.store.get(t.id).status).toBe('CREDIT_BLOCKED');

    const res = await refund(h, t.id);
    expect(res.body.data.topUp.status).toBe('REFUNDED');
    expect(h.ledger.refundCalls).toBe(0);
    expect([...h.razorpay.refunds.values()].map((r) => r.amount)).toEqual([50_000]);
    expect(h.store.audits.find((a) => a.action === 'PAYMENT_REFUND_REQUESTED')!.details).toMatchObject({ ledgerDebit: false });
  });

  it('a blocked top-up whose refund Razorpay refuses goes back to CREDIT_BLOCKED, with nothing to reverse', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.ledger.accounts.get(h.aliceAccount.accountId)!.isActive = false;
    await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    h.razorpay.refundBehaviour = 'reject';
    expect((await refund(h, t.id)).body.error.code).toBe('REFUND_REJECTED');
    expect(h.store.get(t.id).status).toBe('CREDIT_BLOCKED');
    expect(h.ledger.reverseCalls).toBe(0);
  });
});
