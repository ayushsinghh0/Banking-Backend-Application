import crypto from 'crypto';
import request from 'supertest';
import { logger, parseCidrs } from '@banksphere/common';
import { buildHarness, Harness, users, WEBHOOK_SECRET } from './support/harness';

const paymentPayload = (paymentId: string, orderId: string) => ({ payment: { entity: { id: paymentId, entity: 'payment', order_id: orderId } } });

describe('POST /webhooks/razorpay', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('applies a correctly signed payment.captured (re-fetching the payment from Razorpay) without any bearer token', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const res = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('processed');
    expect(h.razorpay.count('fetchPayment')).toBe(1);
    expect(h.store.get(t.id).status).toBe('CREDITED');
    expect(h.store.historyRows.filter((r) => r.topUpId === t.id).map((r) => r.source)).toEqual(['customer', 'webhook', 'webhook']);
  });

  it('acts on what the API says, not on the payload: a payload claiming "captured" for an unpaid payment credits nothing', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'failed' });
    const forgedish = { payment: { entity: { id: pay.id, order_id: t.providerOrderId, status: 'captured', amount: 50000 } } };
    await h.webhook('payment.captured', forgedish);
    expect(h.store.get(t.id).status).toBe('FAILED');
    expect(h.ledger.creditCalls).toBe(0);
  });

  it('rejects an invalid signature with 400 and a security log line (no signature in the log)', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const valid = crypto.createHmac('sha256', WEBHOOK_SECRET).update('x').digest('hex');
    for (const opts of [
      { secret: 'not-the-webhook-secret-123456' },
      { signature: valid }, // a valid HMAC, of other bytes
      { signature: valid.slice(0, 32) }, // wrong length
      { signature: '' },
    ]) {
      const res = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId), opts);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    }
    expect(h.store.get(t.id).status).toBe('CREATED');
    expect(h.razorpay.count('fetchPayment')).toBe(0);
    expect(h.store.webhooks.size).toBe(0); // nothing unauthenticated reaches the inbox
    const securityLines = warn.mock.calls.filter(([fields]) => (fields as { alert?: string })?.alert === 'RAZORPAY_WEBHOOK_SIGNATURE_INVALID');
    expect(securityLines).toHaveLength(4);
    expect(JSON.stringify(securityLines)).not.toContain(valid);
    warn.mockRestore();
  });

  it('refuses a body that was re-serialised in transit (signature covers the raw bytes)', async () => {
    const t = await h.createTopUp();
    const body = { entity: 'event', event: 'payment.captured', payload: paymentPayload('pay_x1', t.providerOrderId) };
    const signedRaw = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedRaw).digest('hex');
    const res = await request(h.app)
      .post('/api/v1/payments/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', 'evt_reserialised')
      .send(JSON.stringify(body, null, 2));
    expect(res.status).toBe(400);
  });

  it('dedupes on X-Razorpay-Event-Id: a redelivery is acknowledged and not applied again', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    const first = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId), { eventId: 'evt_Same0001' });
    const replay = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId), { eventId: 'evt_Same0001' });
    expect(first.body.data.status).toBe('processed');
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe('duplicate');
    expect(h.razorpay.count('fetchPayment')).toBe(1);
    expect(h.ledger.credits.size).toBe(1);
  });

  it('a replayed event id with a different (validly signed) body is never applied', async () => {
    const t = await h.createTopUp();
    const other = await h.createTopUp(users.alice, '1000');
    const pay = h.razorpay.pay(other.providerOrderId, { status: 'captured' });
    await h.webhook('payment.failed', paymentPayload('pay_unknown01', t.providerOrderId), { eventId: 'evt_Reused01' });
    const reused = await h.webhook('payment.captured', paymentPayload(pay.id, other.providerOrderId), { eventId: 'evt_Reused01' });
    expect(reused.status).toBe(200);
    expect(reused.body.data.status).toBe('ignored');
    expect(h.store.get(other.id).status).toBe('CREATED');
  });

  it('reprocesses an event whose earlier delivery failed (Razorpay redelivers on 5xx)', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    h.razorpay.down.add('fetchPayment');
    const failed = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId), { eventId: 'evt_Retry0001' });
    expect(failed.status).toBe(503);
    expect(h.store.webhooks.get('evt_Retry0001')!.status).toBe('FAILED');
    h.razorpay.down.delete('fetchPayment');
    const again = await h.webhook('payment.captured', paymentPayload(pay.id, t.providerOrderId), { eventId: 'evt_Retry0001' });
    expect(again.body.data.status).toBe('processed');
    expect(h.store.webhooks.get('evt_Retry0001')).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    expect(h.store.get(t.id).status).toBe('CREDITED');
  });

  it('handles payment.authorized (captures), order.paid and payment.failed', async () => {
    const a = await h.createTopUp(users.alice, '1000');
    const authorized = h.razorpay.pay(a.providerOrderId, { status: 'authorized' });
    await h.webhook('payment.authorized', paymentPayload(authorized.id, a.providerOrderId));
    expect(h.store.get(a.id).status).toBe('CREDITED');

    const b = await h.createTopUp(users.alice, '1000');
    const paid = h.razorpay.pay(b.providerOrderId, { status: 'captured' });
    await h.webhook('order.paid', { payment: { entity: { id: paid.id, order_id: b.providerOrderId } }, order: { entity: { id: b.providerOrderId } } });
    expect(h.store.get(b.id).status).toBe('CREDITED');

    const c = await h.createTopUp(users.alice, '1000');
    const declined = h.razorpay.pay(c.providerOrderId, { status: 'failed', errorReason: 'payment_cancelled' });
    await h.webhook('payment.failed', paymentPayload(declined.id, c.providerOrderId));
    expect(h.store.get(c.id)).toMatchObject({ status: 'FAILED', failureReason: 'PAYMENT_CANCELLED' });
  });

  it('acknowledges (200, ignored) an event naming a payment Razorpay says does not exist, so Razorpay stops retrying', async () => {
    const t = await h.createTopUp();
    const res = await h.webhook('payment.captured', paymentPayload('pay_DoesNotExist', t.providerOrderId), { eventId: 'evt_Unknown001' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ignored');
    expect(h.store.webhooks.get('evt_Unknown001')!.status).toBe('IGNORED');
    expect(h.store.get(t.id).status).toBe('CREATED');
  });

  it('acknowledges unknown events and events for orders that are not ours, without acting', async () => {
    const unknown = await h.webhook('subscription.charged', { subscription: { entity: { id: 'sub_1' } } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data.status).toBe('ignored');
    const foreign = await h.webhook('payment.captured', paymentPayload('pay_Foreign001', 'order_NotOurs0001'));
    expect(foreign.body.data.status).toBe('ignored');
    expect(h.razorpay.count('fetchPayment')).toBe(0);
  });

  it('requires an event id', async () => {
    const raw = JSON.stringify({ event: 'payment.captured', payload: {} });
    const res = await request(h.app)
      .post('/api/v1/payments/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK');
  });

  it('refuses bodies over 64 KB', async () => {
    const res = await h.webhook('payment.captured', { payment: { entity: { id: 'pay_1', order_id: 'order_1', padding: 'x'.repeat(70 * 1024) } } });
    expect(res.status).toBe(413);
  });

  it('enforces RAZORPAY_WEBHOOK_ALLOWED_CIDRS on the client address when configured', async () => {
    const restricted = buildHarness({ config: { webhookAllowedCidrs: parseCidrs('52.66.0.0/16') } });
    // supertest connects from loopback, which is outside the list
    const res = await restricted.webhook('payment.captured', paymentPayload('pay_1', 'order_1'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WEBHOOK_SOURCE_NOT_ALLOWED');
    const loopback = buildHarness({ config: { webhookAllowedCidrs: parseCidrs('127.0.0.1,::1') } });
    expect((await loopback.webhook('subscription.charged', {})).status).toBe(200);
  });

  it('resumes the refund saga on refund.processed', async () => {
    const t = await h.createTopUp();
    const pay = h.razorpay.pay(t.providerOrderId, { status: 'captured' });
    await h.api.post(`/top-ups/${t.id}/confirm`, users.alice, h.proof(t, pay.id));
    h.razorpay.refundBehaviour = 'pending';
    const res = await h.api.post(`/admin/top-ups/${t.id}/refund`, users.admin, { reason: 'Customer asked to reverse it' });
    expect(res.status).toBe(202);
    const refund = [...h.razorpay.refunds.values()][0];
    refund.status = 'processed'; // Razorpay finished it
    const hook = await h.webhook('refund.processed', { refund: { entity: { id: refund.id, payment_id: pay.id, notes: refund.notes } } });
    expect(hook.body.data.status).toBe('processed');
    expect(h.store.get(t.id).status).toBe('REFUNDED');
  });
});
