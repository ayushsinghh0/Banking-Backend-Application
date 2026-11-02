import { loadPaymentConfig } from '../src/config';

const base = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  RAZORPAY_KEY_ID: 'rzp_test_sim0123456789ab',
  RAZORPAY_KEY_SECRET: 'abcdefghijklmnopqrstuvwx',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_0123456789abcdefghij',
  ...extra,
});

describe('payment-service configuration', () => {
  it('uses the documented defaults', () => {
    const config = loadPaymentConfig(base());
    expect(config.razorpay.apiBase).toBe('https://api.razorpay.com');
    expect(config.limits).toEqual({ minPaise: 100n, maxPaise: 10_000_000n, dailyLimitPaise: 20_000_000n, maxOpenOrders: 3 });
    expect(config.orderTtlMinutes).toBe(30);
    expect(config.stepUp).toEqual({ maxAgeSeconds: 300, minFactorAgeSeconds: 24 * 3600 });
    expect(config.webhookAllowedCidrs).toBeNull();
    expect(config.mode).toBe('test');
    expect(config.simulateEnabled).toBe(false);
  });

  it('reports the mode: simulator for any other API base (outside production), test or live by key prefix', () => {
    expect(loadPaymentConfig(base({ RAZORPAY_API_BASE: 'http://razorpay-simulator:8010/' })).mode).toBe('simulator');
    expect(loadPaymentConfig(base({ RAZORPAY_API_BASE: 'http://razorpay-simulator:8010/' })).razorpay.apiBase).toBe(
      'http://razorpay-simulator:8010'
    );
    expect(loadPaymentConfig(base({ RAZORPAY_API_BASE: 'http://localhost:8010' })).simulateEnabled).toBe(true);
    expect(loadPaymentConfig(base()).mode).toBe('test');
    expect(loadPaymentConfig(base({ RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456' })).mode).toBe('live');
  });

  it('requires the key pair and the webhook secret, and refuses CHANGE_ME placeholders in any environment', () => {
    expect(() => loadPaymentConfig(base({ RAZORPAY_KEY_ID: undefined }))).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_KEY_SECRET: '' }))).toThrow(/RAZORPAY_KEY_SECRET/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_WEBHOOK_SECRET: undefined }))).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_KEY_SECRET: 'CHANGE_ME_razorpay_secret' }))).toThrow(/CHANGE_ME/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_WEBHOOK_SECRET: 'change_me_please_123456' }))).toThrow(/CHANGE_ME/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_KEY_SECRET: 'short' }))).toThrow(/RAZORPAY_KEY_SECRET/);
    expect(() => loadPaymentConfig(base({ RAZORPAY_KEY_ID: 'key_123' }))).toThrow(/RAZORPAY_KEY_ID/);
  });

  describe('in production', () => {
    const prod = (extra: Record<string, string | undefined> = {}) =>
      base({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456', ...extra });

    it('starts with live keys against the official HTTPS API', () => {
      const config = loadPaymentConfig(prod());
      expect(config.mode).toBe('live');
      expect(config.simulateEnabled).toBe(false);
    });

    it('refuses a non-HTTPS API base', () => {
      expect(() => loadPaymentConfig(prod({ RAZORPAY_API_BASE: 'http://api.razorpay.com' }))).toThrow(/HTTPS/);
    });

    it('refuses the simulator (any API base other than Razorpay)', () => {
      expect(() => loadPaymentConfig(prod({ RAZORPAY_API_BASE: 'https://razorpay-simulator:8010' }))).toThrow(/simulator/i);
      expect(() => loadPaymentConfig(prod({ RAZORPAY_API_BASE: 'http://razorpay-simulator:8010' }))).toThrow();
    });

    it('refuses rzp_test_ keys unless RAZORPAY_ALLOW_TEST_KEYS=true', () => {
      expect(() => loadPaymentConfig(prod({ RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456' }))).toThrow(/RAZORPAY_ALLOW_TEST_KEYS/);
      const staging = loadPaymentConfig(prod({ RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456', RAZORPAY_ALLOW_TEST_KEYS: 'true' }));
      expect(staging.mode).toBe('test');
    });
  });

  it('parses the webhook source allowlist and rejects malformed networks', () => {
    const config = loadPaymentConfig(base({ RAZORPAY_WEBHOOK_ALLOWED_CIDRS: '52.66.0.0/16, 13.232.125.244' }));
    expect(config.webhookAllowedCidrs?.check('52.66.1.2')).toBe(true);
    expect(config.webhookAllowedCidrs?.check('10.0.0.1')).toBe(false);
    expect(() => loadPaymentConfig(base({ RAZORPAY_WEBHOOK_ALLOWED_CIDRS: '52.66.0.0/99' }))).toThrow(/RAZORPAY_WEBHOOK_ALLOWED_CIDRS/);
  });

  it('validates every limit (an empty or nonsensical value stops the service instead of disabling a control)', () => {
    expect(() => loadPaymentConfig(base({ TOPUP_MIN_PAISE: '' }))).toThrow(/TOPUP_MIN_PAISE/);
    expect(() => loadPaymentConfig(base({ TOPUP_MIN_PAISE: '50' }))).toThrow(/TOPUP_MIN_PAISE/); // Razorpay's minimum is ₹1
    expect(() => loadPaymentConfig(base({ TOPUP_MAX_PAISE: '99' }))).toThrow(/TOPUP_MAX_PAISE/);
    expect(() => loadPaymentConfig(base({ TOPUP_DAILY_LIMIT_PAISE: '1e9' }))).toThrow(/TOPUP_DAILY_LIMIT_PAISE/);
    expect(() => loadPaymentConfig(base({ TOPUP_ORDER_TTL_MINUTES: '0' }))).toThrow(/TOPUP_ORDER_TTL_MINUTES/);
    expect(() => loadPaymentConfig(base({ STEP_UP_MAX_AGE_SECONDS: '-1' }))).toThrow(/STEP_UP_MAX_AGE_SECONDS/);
    const custom = loadPaymentConfig(
      base({ TOPUP_MIN_PAISE: '500', TOPUP_MAX_PAISE: '5000000', TOPUP_DAILY_LIMIT_PAISE: '9000000', MFA_FACTOR_MIN_AGE_HOURS: '0' })
    );
    expect(custom.limits).toMatchObject({ minPaise: 500n, maxPaise: 5_000_000n, dailyLimitPaise: 9_000_000n });
    expect(custom.stepUp.minFactorAgeSeconds).toBe(0);
  });
});
