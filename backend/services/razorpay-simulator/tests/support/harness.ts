import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../../src/app';
import { SimulatorConfig } from '../../src/config';

export const KEY_ID = 'rzp_test_SimUnit000001';
export const KEY_SECRET = 'sim_key_secret_0123456789abcdef';
export const WEBHOOK_SECRET = 'sim_webhook_secret_0123456789abc';

export const basic = (keyId = KEY_ID, secret = KEY_SECRET) => `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;

/** The verifications payment-service performs, written out again here so the two sides stay independent */
export const sign = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const verifyPaymentSignature = (orderId: string, paymentId: string, signature: string, keySecret = KEY_SECRET) =>
  signature.length === 64 && crypto.timingSafeEqual(Buffer.from(sign(keySecret, `${orderId}|${paymentId}`), 'hex'), Buffer.from(signature, 'hex'));
export const verifyWebhookSignature = (raw: string | Buffer, signature: string, secret = WEBHOOK_SECRET) =>
  signature.length === 64 && crypto.timingSafeEqual(Buffer.from(sign(secret, raw), 'hex'), Buffer.from(signature, 'hex'));

export function testConfig(overrides: Partial<SimulatorConfig> = {}): SimulatorConfig {
  return { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, webhookUrl: null, port: 0, ...overrides };
}

export interface ReceivedWebhook {
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: { entity: string; event: string; contains: string[]; payload: Record<string, { entity: Record<string, unknown> }>; created_at: number };
}

/**
 * A stand-in for payment-service's webhook endpoint: records every delivery with its exact bytes and
 * answers with the next scripted status (200 once the script runs out).
 */
export async function startReceiver(script: number[] = []) {
  const received: ReceivedWebhook[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
      const status = script.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ success: status < 400 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/payments/webhooks/razorpay`;
  return {
    url,
    received,
    script,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function buildHarness(options: { config?: Partial<SimulatorConfig>; start?: Date } = {}) {
  const clock = { now: options.start ?? new Date('2026-10-28T06:00:00.000Z') };
  const { app, store, webhooks } = createApp({
    config: testConfig(options.config),
    now: () => new Date(clock.now),
    webhooks: { retryDelaysMs: [10, 20], timeoutMs: 2_000 },
  });
  const api = {
    get: (path: string, auth: string | null = basic()) => {
      const req = request(app).get(path);
      return auth ? req.set('authorization', auth) : req;
    },
    post: (path: string, body?: unknown, auth: string | null = basic()) => {
      let req = request(app).post(path);
      if (auth) req = req.set('authorization', auth);
      return body === undefined ? req : req.send(body as object);
    },
  };
  return {
    app,
    store,
    webhooks,
    api,
    clock,
    async createOrder(amount = 50_000, extra: Record<string, unknown> = {}) {
      const res = await api.post('/v1/orders', { amount, currency: 'INR', receipt: 'topup-1', notes: { topUpId: 'topup-1' }, ...extra });
      if (res.status !== 200) throw new Error(`createOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as { id: string; amount: number; currency: string };
    },
    async checkout(orderId: string, outcome: 'success' | 'authorized' | 'failure' = 'success', method = 'upi') {
      const res = await api.post(`/sim/checkout/${orderId}`, { outcome, method });
      if (res.status !== 200) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
    },
  };
}

export type Harness = ReturnType<typeof buildHarness>;
