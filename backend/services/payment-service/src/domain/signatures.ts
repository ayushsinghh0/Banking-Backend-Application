import crypto from 'crypto';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Compares two hex digests in constant time. Anything that isn't exactly a 64-digit hex string is refused
 * before the comparison, so a wrong length can neither throw (timingSafeEqual requires equal lengths) nor
 * leak where the strings differ.
 */
export function constantTimeHexEqual(expectedHex: string, presentedHex: string | undefined): boolean {
  if (typeof presentedHex !== 'string' || !HEX_SHA256.test(presentedHex) || !HEX_SHA256.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const presented = Buffer.from(presentedHex, 'hex');
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * The signature Razorpay Checkout hands the browser after a successful payment:
 * HMAC_SHA256(order_id + "|" + payment_id, key_secret). The order id must be the one WE created for the
 * top-up (never the client's copy), so a valid signature for another order can't be replayed here.
 */
export function verifyPaymentSignature(
  input: { orderId: string; paymentId: string; signature: string | undefined },
  keySecret: string
): boolean {
  return constantTimeHexEqual(hmacSha256Hex(keySecret, `${input.orderId}|${input.paymentId}`), input.signature);
}

/** X-Razorpay-Signature: HMAC_SHA256 over the exact raw request body with the webhook secret */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined, webhookSecret: string): boolean {
  if (!rawBody || rawBody.length === 0) return false;
  return constantTimeHexEqual(hmacSha256Hex(webhookSecret, rawBody), signature);
}
