import { createApp } from '../src/app';
import { SimulatorConfigError, loadSimulatorConfig } from '../src/config';
import { buildHarness, testConfig } from './support/harness';

const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  RAZORPAY_KEY_ID: 'rzp_test_sim4b9f22161cd0',
  RAZORPAY_KEY_SECRET: '8OvWHGuf0ohN9WR4JBGcEThU',
  RAZORPAY_WEBHOOK_SECRET: '6083b73c4fbc43461063bb312529b079',
  SIM_WEBHOOK_URL: 'http://payment-service:8007/api/v1/payments/webhooks/razorpay',
  PORT: '8010',
  ...extra,
});

describe('razorpay-simulator configuration', () => {
  it('reads the key pair, webhook secret, target and port', () => {
    expect(loadSimulatorConfig(env())).toEqual({
      keyId: 'rzp_test_sim4b9f22161cd0',
      keySecret: '8OvWHGuf0ohN9WR4JBGcEThU',
      webhookSecret: '6083b73c4fbc43461063bb312529b079',
      webhookUrl: 'http://payment-service:8007/api/v1/payments/webhooks/razorpay',
      port: 8010,
    });
    expect(loadSimulatorConfig(env({ SIM_WEBHOOK_URL: undefined, PORT: undefined }))).toMatchObject({ webhookUrl: null, port: 8010 });
  });

  it('refuses to start in production', () => {
    expect(() => loadSimulatorConfig(env({ NODE_ENV: 'production' }))).toThrow(SimulatorConfigError);
    expect(() => loadSimulatorConfig(env({ NODE_ENV: 'production' }))).toThrow(/production/);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createApp({ config: testConfig() })).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('refuses live keys, missing secrets and placeholders', () => {
    expect(() => loadSimulatorConfig(env({ RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456' }))).toThrow(/live/);
    expect(() => loadSimulatorConfig(env({ RAZORPAY_KEY_ID: 'key_123' }))).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => loadSimulatorConfig(env({ RAZORPAY_KEY_SECRET: '' }))).toThrow(/RAZORPAY_KEY_SECRET/);
    expect(() => loadSimulatorConfig(env({ RAZORPAY_WEBHOOK_SECRET: undefined }))).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    expect(() => loadSimulatorConfig(env({ RAZORPAY_KEY_SECRET: 'CHANGE_ME_secret' }))).toThrow(/CHANGE_ME/);
  });

  it('validates the webhook target and the port', () => {
    expect(() => loadSimulatorConfig(env({ SIM_WEBHOOK_URL: 'payment-service/webhooks' }))).toThrow(/SIM_WEBHOOK_URL/);
    expect(() => loadSimulatorConfig(env({ SIM_WEBHOOK_URL: 'ftp://payment-service/webhooks' }))).toThrow(/SIM_WEBHOOK_URL/);
    expect(() => loadSimulatorConfig(env({ PORT: 'eighty' }))).toThrow(/PORT/);
    expect(() => loadSimulatorConfig(env({ PORT: '70000' }))).toThrow(/PORT/);
  });
});

describe('GET /health', () => {
  it('reports UP with the service name (what the compose healthcheck polls)', async () => {
    const h = buildHarness();
    const res = await h.api.get('/health', null);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'UP', service: 'razorpay-simulator', timestamp: h.clock.now.toISOString() });
  });
});
