import crypto from 'crypto';
import { constantTimeHexEqual, hmacSha256Hex, verifyPaymentSignature, verifyWebhookSignature } from '../src/domain/signatures';

const KEY_SECRET = 'key_secret_for_tests_0123456789';
const WEBHOOK_SECRET = 'webhook_secret_for_tests_0123456789';
const sign = (data: string | Buffer, secret: string) => crypto.createHmac('sha256', secret).update(data).digest('hex');

describe('Checkout payment signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)', () => {
  const orderId = 'order_ABC123def456';
  const paymentId = 'pay_XYZ789ghi012';
  const valid = sign(`${orderId}|${paymentId}`, KEY_SECRET);

  it('accepts the signature Razorpay computes', () => {
    expect(verifyPaymentSignature({ orderId, paymentId, signature: valid }, KEY_SECRET)).toBe(true);
  });

  it('accepts upper-case hex (case is not part of the MAC)', () => {
    expect(verifyPaymentSignature({ orderId, paymentId, signature: valid.toUpperCase() }, KEY_SECRET)).toBe(true);
  });

  it('refuses a tampered signature, payment id or order id', () => {
    const flipped = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
    expect(verifyPaymentSignature({ orderId, paymentId, signature: flipped }, KEY_SECRET)).toBe(false);
    expect(verifyPaymentSignature({ orderId, paymentId: 'pay_OTHER0000000', signature: valid }, KEY_SECRET)).toBe(false);
    expect(verifyPaymentSignature({ orderId: 'order_OTHER00000', paymentId, signature: valid }, KEY_SECRET)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifyPaymentSignature({ orderId, paymentId, signature: sign(`${orderId}|${paymentId}`, 'other') }, KEY_SECRET)).toBe(false);
  });

  it('refuses wrong-length, non-hex and empty signatures without throwing', () => {
    for (const signature of [valid.slice(0, 63), valid + '0', valid + valid, '', 'z'.repeat(64), ` ${valid.slice(1)}`]) {
      expect(verifyPaymentSignature({ orderId, paymentId, signature }, KEY_SECRET)).toBe(false);
    }
  });

  it('does not let the separator be shifted between the ids', () => {
    // "order_A|Bpay" vs "order_A|B" + "pay": the ids are joined exactly as Razorpay does
    const sig = sign('order_A|pay_B', KEY_SECRET);
    expect(verifyPaymentSignature({ orderId: 'order_A|pay', paymentId: '_B', signature: sig }, KEY_SECRET)).toBe(false);
  });
});

describe('Webhook signature: HMAC_SHA256(raw body, webhook secret)', () => {
  const body = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}');
  const valid = sign(body, WEBHOOK_SECRET);

  it('accepts the signature over the exact raw bytes', () => {
    expect(verifyWebhookSignature(body, valid, WEBHOOK_SECRET)).toBe(true);
  });

  it('refuses a body changed by a single byte or re-serialised', () => {
    const changed = Buffer.from(body.toString().replace('pay_1', 'pay_2'));
    expect(verifyWebhookSignature(changed, valid, WEBHOOK_SECRET)).toBe(false);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyWebhookSignature(reserialised, valid, WEBHOOK_SECRET)).toBe(false);
  });

  it('refuses a signature made with the key secret instead of the webhook secret', () => {
    expect(verifyWebhookSignature(body, sign(body, KEY_SECRET), WEBHOOK_SECRET)).toBe(false);
  });

  it('refuses missing, wrong-length and non-hex signatures', () => {
    for (const signature of [undefined, '', valid.slice(2), `${valid}00`, 'g'.repeat(64)]) {
      expect(verifyWebhookSignature(body, signature, WEBHOOK_SECRET)).toBe(false);
    }
  });

  it('refuses when there is no body at all', () => {
    expect(verifyWebhookSignature(undefined, valid, WEBHOOK_SECRET)).toBe(false);
  });
});

describe('constant-time hex comparison', () => {
  it('compares decoded bytes with timingSafeEqual only when the lengths match', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    const a = hmacSha256Hex('secret', 'data');
    expect(constantTimeHexEqual(a, a)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(constantTimeHexEqual(a, a.slice(2))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1); // a wrong length never reaches timingSafeEqual (which would throw)
    spy.mockRestore();
  });
});
