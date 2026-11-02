export interface SimulatorConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Where signed webhooks go (payment-service's /webhooks/razorpay); null disables delivery */
  webhookUrl: string | null;
  port: number;
}

const TEST_KEY_ID = /^rzp_test_[A-Za-z0-9]{6,64}$/;
const PLACEHOLDER = /CHANGE_ME/i;

export class SimulatorConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new SimulatorConfigError(`${name} must be set`);
  if (PLACEHOLDER.test(value)) throw new SimulatorConfigError(`${name} still contains the CHANGE_ME placeholder`);
  return value;
}

/** The one rule that matters most: this process never runs where real money is */
export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production') {
    throw new SimulatorConfigError('The Razorpay simulator is a development tool and refuses to start with NODE_ENV=production');
  }
}

/**
 * Reads the simulator's settings. It shares the key pair and webhook secret with payment-service (that is
 * what makes its signatures verify there) and refuses anything that smells of production: NODE_ENV, or a
 * live key, which would mean someone pointed real credentials at a toy.
 */
export function loadSimulatorConfig(env: NodeJS.ProcessEnv = process.env): SimulatorConfig {
  assertNotProduction(env);
  const keyId = required(env, 'RAZORPAY_KEY_ID');
  if (!TEST_KEY_ID.test(keyId)) {
    throw new SimulatorConfigError('RAZORPAY_KEY_ID must be a test key (rzp_test_...); the simulator never accepts live keys');
  }
  const keySecret = required(env, 'RAZORPAY_KEY_SECRET');
  const webhookSecret = required(env, 'RAZORPAY_WEBHOOK_SECRET');

  let webhookUrl: string | null = null;
  const rawUrl = env.SIM_WEBHOOK_URL?.trim();
  if (rawUrl) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SimulatorConfigError('SIM_WEBHOOK_URL must be an absolute http(s) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SimulatorConfigError('SIM_WEBHOOK_URL must be http(s)');
    webhookUrl = url.toString();
  }

  const rawPort = env.PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? 8010 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SimulatorConfigError(`Invalid PORT=${JSON.stringify(env.PORT)}`);

  return { keyId, keySecret, webhookSecret, webhookUrl, port };
}
