import crypto from 'crypto';

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** What Checkout.js hands the merchant's page: HMAC_SHA256(order_id + "|" + payment_id, key_secret) */
export function paymentSignature(orderId: string, paymentId: string, keySecret: string): string {
  return hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
}

/** X-Razorpay-Signature: HMAC_SHA256 over the exact bytes of the webhook body with the webhook secret */
export function webhookSignature(rawBody: string | Buffer, webhookSecret: string): string {
  return hmacSha256Hex(webhookSecret, rawBody);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Razorpay ids are a prefix and 14 alphanumerics (order_Abc..., pay_..., rfnd_..., evt_...) */
export function razorpayId(prefix: 'order' | 'pay' | 'rfnd' | 'evt' | 'card'): string {
  const bytes = crypto.randomBytes(14);
  let body = '';
  for (const byte of bytes) body += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${body}`;
}
