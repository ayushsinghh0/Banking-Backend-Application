import crypto from 'crypto';
import request from 'supertest';
import { InMemoryTokenStateStore, UserRole, generateJwtKeyPair, signAccessToken } from '@banksphere/common';
import { createApp, PAYMENTS_PREFIX } from '../../src/app';
import { PaymentConfig } from '../../src/config';
import { TopUp } from '../../src/domain/types';
import { FakeCustomers, FakeLedger, FakeRazorpay } from './fakes';
import { MemoryStore } from './memory-store';

export const KEY_SECRET = 'test_key_secret_0123456789abcdef';
export const WEBHOOK_SECRET = 'test_webhook_secret_0123456789ab';

let jwtReady = false;
function ensureJwt() {
  if (jwtReady) return;
  const { privateKeyB64, publicKeyB64 } = generateJwtKeyPair();
  process.env.JWT_SIGNING_KEY = privateKeyB64;
  process.env.JWT_SIGNING_KEY_ID = 'test-kid';
  process.env.JWT_VERIFY_KEYS = `test-kid:${publicKeyB64}`;
  jwtReady = true;
}

export interface TestUser {
  id: string;
  email: string;
  role: UserRole;
  mfa?: boolean;
  /** seconds ago the TOTP step-up happened (undefined: never) */
  stepUpAgo?: number;
  /** seconds ago the factor was enrolled */
  factorAge?: number;
}

export const users = {
  alice: { id: crypto.randomUUID(), email: 'alice@example.com', role: 'CUSTOMER' },
  bob: { id: crypto.randomUUID(), email: 'bob@example.com', role: 'CUSTOMER' },
  admin: { id: crypto.randomUUID(), email: 'admin@bank.example', role: 'BANK_ADMIN', mfa: true, stepUpAgo: 10, factorAge: 3 * 86400 },
  adminNoStepUp: { id: crypto.randomUUID(), email: 'admin2@bank.example', role: 'BANK_ADMIN', mfa: true, factorAge: 3 * 86400 },
  adminStaleStepUp: { id: crypto.randomUUID(), email: 'admin3@bank.example', role: 'BANK_ADMIN', mfa: true, stepUpAgo: 3600, factorAge: 3 * 86400 },
  adminNewFactor: { id: crypto.randomUUID(), email: 'admin4@bank.example', role: 'BANK_ADMIN', mfa: true, stepUpAgo: 10, factorAge: 60 },
  support: { id: crypto.randomUUID(), email: 'support@bank.example', role: 'SUPPORT', mfa: true },
  fraud: { id: crypto.randomUUID(), email: 'fraud@bank.example', role: 'FRAUD_ANALYST', mfa: true },
  teller: { id: crypto.randomUUID(), email: 'teller@bank.example', role: 'TELLER', mfa: true },
  kyc: { id: crypto.randomUUID(), email: 'kyc@bank.example', role: 'KYC_OFFICER', mfa: true },
} satisfies Record<string, TestUser>;

export function bearer(user: TestUser): string {
  ensureJwt();
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: 0,
    mfa: Boolean(user.mfa),
    sessionId: crypto.randomUUID(),
    ...(user.stepUpAgo !== undefined ? { stepUpAt: now - user.stepUpAgo } : {}),
    ...(user.factorAge !== undefined ? { mfaSince: now - user.factorAge } : {}),
  })}`;
}

export function testConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    production: false,
    mode: 'test',
    simulateEnabled: false,
    razorpay: { keyId: 'rzp_test_UnitTest01', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, apiBase: 'https://api.razorpay.com', timeoutMs: 1000 },
    webhookAllowedCidrs: null,
    limits: { minPaise: 100n, maxPaise: 10_000_000n, dailyLimitPaise: 20_000_000n, maxOpenOrders: 3 },
    orderTtlMinutes: 30,
    stepUp: { maxAgeSeconds: 300, minFactorAgeSeconds: 24 * 3600 },
    checkoutName: 'BankSphere',
    ...overrides,
  };
}

export function buildHarness(options: { config?: Partial<PaymentConfig>; start?: Date } = {}) {
  ensureJwt();
  const clock = { now: options.start ?? new Date('2026-10-28T06:00:00.000Z') };
  const now = () => new Date(clock.now);
  const config = testConfig(options.config);
  const store = new MemoryStore(now);
  const razorpay = new FakeRazorpay(KEY_SECRET);
  const ledger = new FakeLedger();
  const customers = new FakeCustomers();
  const { app, services } = createApp({
    config,
    store,
    razorpay,
    ledger,
    customers,
    tokenState: new InMemoryTokenStateStore(),
    staffNetworks: null,
    now,
    reconciler: { budgetMs: 20_000, batchSize: 50 },
  });
  const aliceAccount = ledger.addAccount(users.alice.id, { accountNumberLast4: '4321' });
  const bobAccount = ledger.addAccount(users.bob.id, { accountNumberLast4: '8765' });

  const api = {
    get: (path: string, user: TestUser) => request(app).get(`${PAYMENTS_PREFIX}${path}`).set('authorization', bearer(user)),
    post: (path: string, user: TestUser, body?: unknown, headers: Record<string, string> = {}) => {
      let req = request(app).post(`${PAYMENTS_PREFIX}${path}`).set('authorization', bearer(user));
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      return body === undefined ? req : req.send(body as object);
    },
  };

  const h = {
    app,
    services,
    store,
    razorpay,
    ledger,
    customers,
    config,
    clock,
    api,
    aliceAccount,
    bobAccount,
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    /** Creates a top-up over HTTP and returns the stored row */
    async createTopUp(user: TestUser = users.alice, amountPaise = '50000', accountId = aliceAccount.accountId, key = `key-${crypto.randomUUID()}`) {
      const res = await api.post('/top-ups', user, { accountId, amountPaise }, { 'idempotency-key': key });
      if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
      return store.get(res.body.data.topUp.id);
    },
    proof(topUp: TopUp, paymentId: string) {
      return { razorpayPaymentId: paymentId, razorpayOrderId: topUp.providerOrderId, razorpaySignature: razorpay.sign(topUp.providerOrderId, paymentId) };
    },
    webhook(event: string, payload: Record<string, unknown>, opts: { eventId?: string; secret?: string; signature?: string; ip?: string } = {}) {
      const raw = Buffer.from(JSON.stringify({ entity: 'event', account_id: 'acc_Test', event, contains: Object.keys(payload), payload, created_at: 1 }));
      const signature = opts.signature ?? crypto.createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(raw).digest('hex');
      let req = request(app)
        .post(`${PAYMENTS_PREFIX}/webhooks/razorpay`)
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', signature)
        .set('x-razorpay-event-id', opts.eventId ?? `evt_${crypto.randomBytes(7).toString('hex')}`);
      if (opts.ip) req = req.set('x-forwarded-for', opts.ip);
      return req.send(raw.toString());
    },
    statuses(topUpId: string) {
      return store.historyRows.filter((r) => r.topUpId === topUpId).map((r) => r.to);
    },
  };
  return h;
}

export type Harness = ReturnType<typeof buildHarness>;
