import dotenv from 'dotenv';
import { Request, Response } from 'express';
import { createBaseApp, logger, startHttpServer } from '@banksphere/common';
import { basicAuth } from './auth';
import { SimulatorConfig, assertNotProduction, loadSimulatorConfig } from './config';
import { RazorpayErrors, razorpayErrorHandler } from './errors';
import { createRazorpayRouter, createSimRouter } from './routes';
import { SimulatorStore } from './store';
import { WebhookDispatcher, WebhookDispatcherOptions } from './webhooks';

export interface SimulatorAppOptions {
  config: SimulatorConfig;
  now?: () => Date;
  /** Delivery tuning (retry waits, fetch implementation); tests shorten the waits */
  webhooks?: Partial<Omit<WebhookDispatcherOptions, 'url' | 'secret'>>;
}

/**
 * Razorpay, in memory, for development and end-to-end tests: the REST calls payment-service makes under
 * /v1 (basic auth on the key pair), a Checkout stand-in under /sim, and signed webhooks to SIM_WEBHOOK_URL.
 * It is only ever wired into docker-compose.dev.yml and refuses to exist in production.
 */
export function createApp(options: SimulatorAppOptions) {
  assertNotProduction();
  const now = options.now ?? (() => new Date());
  const { config } = options;
  const store = new SimulatorStore(now);
  const webhooks = new WebhookDispatcher({ ...options.webhooks, url: config.webhookUrl, secret: config.webhookSecret, now });
  const auth = basicAuth(config.keyId, config.keySecret);

  const app = createBaseApp();
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'UP', service: 'razorpay-simulator', timestamp: now().toISOString() });
  });
  app.use('/v1', createRazorpayRouter(store, webhooks, auth));
  app.use('/sim', createSimRouter(store, webhooks, auth, config.keySecret));
  app.use((_req: Request, _res: Response, next) => next(RazorpayErrors.unknownRoute()));
  app.use(razorpayErrorHandler);

  return { app, store, webhooks };
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const config = loadSimulatorConfig();
  const { app, webhooks } = createApp({ config });
  // The key id is public; the secrets never are. The webhook target host says where events will go.
  logger.info(
    { keyId: config.keyId, webhookTarget: config.webhookUrl ? new URL(config.webhookUrl).host : null },
    'Razorpay simulator configured (development only)'
  );
  startHttpServer(app, config.port, 'razorpay-simulator', [() => webhooks.idle()]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'razorpay-simulator failed to start');
    process.exit(1);
  });
}
