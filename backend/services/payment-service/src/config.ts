import net from 'net';
import { parseCidrs } from '@banksphere/common';

export type PaymentMode = 'live' | 'test' | 'simulator';

export interface TopUpLimits {
  minPaise: bigint;
  maxPaise: bigint;
  dailyLimitPaise: bigint;
  /** Orders a customer may have waiting for payment at once (design: at most 3) */
  maxOpenOrders: number;
}

export interface PaymentConfig {
  production: boolean;
  mode: PaymentMode;
  /** POST /top-ups/:id/simulate is served only in simulator mode outside production */
  simulateEnabled: boolean;
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    apiBase: string;
    timeoutMs: number;
  };
  webhookAllowedCidrs: net.BlockList | null;
  limits: TopUpLimits;
  orderTtlMinutes: number;
  stepUp: { maxAgeSeconds: number; minFactorAgeSeconds: number };
  checkoutName: string;
}

export const OFFICIAL_RAZORPAY_API = 'https://api.razorpay.com';
const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,64}$/;
const PLACEHOLDER = /CHANGE_ME/i;
const RAZORPAY_MIN_PAISE = 100n; // Razorpay refuses INR orders below ₹1.00

function required(env: NodeJS.ProcessEnv, name: string, minLength = 1): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  if (PLACEHOLDER.test(value)) throw new Error(`${name} still contains the CHANGE_ME placeholder`);
  if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  return value;
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!/^\d{1,15}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number between ${min} and ${max}`);
  }
  return Number(value);
}

function paise(env: NodeJS.ProcessEnv, name: string, fallback: bigint, min: bigint): bigint {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  // Amounts go to Razorpay as JSON numbers, so they must stay exact as a double
  if (!/^\d{1,15}$/.test(value) || BigInt(value) < min || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number of paise >= ${min}`);
  }
  return BigInt(value);
}

function apiBase(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL((raw?.trim() || OFFICIAL_RAZORPAY_API).replace(/\/+$/, ''));
  } catch {
    throw new Error('RAZORPAY_API_BASE must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('RAZORPAY_API_BASE must be http(s)');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('RAZORPAY_API_BASE must not carry credentials, a query or a fragment');
  }
  return url;
}

/**
 * Reads and validates the payment configuration. Anything wrong stops the service at startup: a missing
 * secret, a placeholder, a limit that would silently disable a control, or (in production) anything that
 * isn't real Razorpay over HTTPS with live keys.
 */
export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const production = env.NODE_ENV === 'production';
  const keyId = required(env, 'RAZORPAY_KEY_ID');
  if (!KEY_ID.test(keyId)) throw new Error('RAZORPAY_KEY_ID must look like rzp_test_... or rzp_live_...');
  const keySecret = required(env, 'RAZORPAY_KEY_SECRET', 16);
  const webhookSecret = required(env, 'RAZORPAY_WEBHOOK_SECRET', 16);

  const base = apiBase(env.RAZORPAY_API_BASE);
  const official = base.protocol === 'https:' && base.hostname === 'api.razorpay.com' && (base.port === '' || base.port === '443');
  const testKey = keyId.startsWith('rzp_test_');

  if (production) {
    if (base.protocol !== 'https:') throw new Error('RAZORPAY_API_BASE must use HTTPS in production');
    if (!official) throw new Error('RAZORPAY_API_BASE must be the Razorpay API in production (the simulator is development only)');
    if (testKey && env.RAZORPAY_ALLOW_TEST_KEYS !== 'true') {
      throw new Error('Refusing rzp_test_ keys in production; set RAZORPAY_ALLOW_TEST_KEYS=true only for a staging deployment');
    }
  }

  const mode: PaymentMode = !official ? 'simulator' : testKey ? 'test' : 'live';

  let webhookAllowedCidrs: net.BlockList | null;
  try {
    webhookAllowedCidrs = parseCidrs(env.RAZORPAY_WEBHOOK_ALLOWED_CIDRS);
  } catch {
    throw new Error('RAZORPAY_WEBHOOK_ALLOWED_CIDRS must be a comma-separated list of IP addresses or CIDR networks');
  }

  const minPaise = paise(env, 'TOPUP_MIN_PAISE', 100n, RAZORPAY_MIN_PAISE);
  const maxPaise = paise(env, 'TOPUP_MAX_PAISE', 10_000_000n, minPaise);
  const dailyLimitPaise = paise(env, 'TOPUP_DAILY_LIMIT_PAISE', 20_000_000n, minPaise);

  return {
    production,
    mode,
    simulateEnabled: mode === 'simulator' && !production,
    razorpay: {
      keyId,
      keySecret,
      webhookSecret,
      apiBase: base.toString().replace(/\/+$/, ''),
      timeoutMs: wholeNumber(env, 'RAZORPAY_TIMEOUT_MS', 10_000, 1_000, 60_000),
    },
    webhookAllowedCidrs,
    limits: { minPaise, maxPaise, dailyLimitPaise, maxOpenOrders: 3 },
    orderTtlMinutes: wholeNumber(env, 'TOPUP_ORDER_TTL_MINUTES', 30, 1, 24 * 60),
    stepUp: {
      maxAgeSeconds: wholeNumber(env, 'STEP_UP_MAX_AGE_SECONDS', 300, 1, 3600),
      minFactorAgeSeconds: wholeNumber(env, 'MFA_FACTOR_MIN_AGE_HOURS', 24, 0, 24 * 365) * 3600,
    },
    checkoutName: 'BankSphere',
  };
}
