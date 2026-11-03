import net from 'net';
import dotenv from 'dotenv';
import { Request, Response } from 'express';
import {
  OutboxRelay,
  RedisTokenStateStore,
  TokenStateStore,
  assertJwtVerificationConfigured,
  assertNoPlaceholders,
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  getInternalToken,
  logger,
  notFoundHandler,
  prismaClientOptions,
  startHttpServer,
} from '@banksphere/common';
import { PrismaClient } from '../generated/client';
import { PaymentConfig, loadPaymentConfig } from './config';
import { RazorpayApi, RazorpayClient } from './clients/razorpay.client';
import { HttpLedgerClient, LedgerApi } from './clients/ledger.client';
import { CustomerApi, HttpCustomerClient } from './clients/customer.client';
import { PaymentController, WebhookController } from './controllers/payment.controller';
import { createPaymentRouter, createWebhookRouter } from './routes/payment.routes';
import { PaymentStore } from './store/payment-store';
import { PrismaPaymentStore } from './store/prisma-payment-store';
import { AdminService } from './services/admin.service';
import { Reconciler, ReconcilerOptions } from './services/reconciler';
import { RefundService } from './services/refund.service';
import { SettlementService } from './services/settlement.service';
import { StateWriter } from './services/state-writer';
import { TopUpService } from './services/topup.service';
import { WebhookService } from './services/webhook.service';

export const PAYMENTS_PREFIX = '/api/v1/payments';
export const WEBHOOK_PATH = `${PAYMENTS_PREFIX}/webhooks/razorpay`;

export interface PaymentAppDeps {
  config: PaymentConfig;
  store: PaymentStore;
  razorpay: RazorpayApi;
  ledger: LedgerApi;
  customers: CustomerApi;
  tokenState: TokenStateStore;
  /** Readiness also needs the security Redis (token state) */
  redis?: { ping(): Promise<unknown> };
  now?: () => Date;
  /** Defaults to STAFF_ALLOWED_CIDRS */
  staffNetworks?: net.BlockList | null;
  reconciler?: ReconcilerOptions;
}

export function createApp(deps: PaymentAppDeps) {
  assertJwtVerificationConfigured();
  const now = deps.now ?? (() => new Date());
  // The webhook signature covers the exact bytes Razorpay sent, so they are kept next to the parsed JSON
  const app = createBaseApp({ keepRawBody: (req) => (req.originalUrl || req.url).split('?')[0] === WEBHOOK_PATH });

  const writer = new StateWriter(deps.store);
  const settlement = new SettlementService(deps.store, writer, deps.razorpay, deps.ledger, now);
  const refunds = new RefundService(deps.store, writer, deps.razorpay, deps.ledger, deps.config, now);
  const topUps = new TopUpService(deps.store, writer, settlement, deps.razorpay, deps.ledger, deps.customers, deps.config, now);
  const webhooks = new WebhookService(deps.store, settlement, refunds, deps.razorpay, deps.config);
  const admin = new AdminService(deps.store, now);
  const reconciler = new Reconciler(deps.store, writer, settlement, refunds, deps.razorpay, now, deps.reconciler);

  const authenticate = createAuthenticate(deps.tokenState, deps.staffNetworks !== undefined ? { staffNetworks: deps.staffNetworks } : {});
  app.use(PAYMENTS_PREFIX, createWebhookRouter(new WebhookController(webhooks)));
  app.use(PAYMENTS_PREFIX, createPaymentRouter(new PaymentController(topUps, refunds, admin, reconciler), authenticate));

  app.get('/health', async (req: Request, res: Response) => {
    try {
      await deps.store.ping();
      if (deps.redis) await deps.redis.ping();
      res.json({ status: 'UP', service: 'payment-service', mode: deps.config.mode, timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'payment-service' });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return { app, services: { topUps, settlement, refunds, webhooks, admin, reconciler } };
}

function intervalMs(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw.trim()) || Number(raw) < min) throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected milliseconds >= ${min}`);
  return Number(raw);
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  assertNoPlaceholders([
    'DATABASE_URL',
    'REDIS_URL',
    'KAFKA_PASSWORD',
    'JWT_VERIFY_KEYS',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'PAYMENT_LEDGER_INTERNAL_TOKEN',
    'CUSTOMER_INTERNAL_TOKEN',
  ]);
  // Everything is validated before anything starts: a bad value stops the service here
  const config = loadPaymentConfig();
  const ledgerToken = getInternalToken('PAYMENT_LEDGER_INTERNAL_TOKEN');
  const customerToken = getInternalToken('CUSTOMER_INTERNAL_TOKEN');
  const outboxPollMs = intervalMs('OUTBOX_POLL_INTERVAL_MS', 1_000, 100);
  const reconcileMs = intervalMs('PAYMENT_RECONCILE_INTERVAL_MS', 60_000, 5_000);

  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  const { app, services } = createApp({
    config,
    store: new PrismaPaymentStore(prisma),
    razorpay: new RazorpayClient({
      apiBase: config.razorpay.apiBase,
      keyId: config.razorpay.keyId,
      keySecret: config.razorpay.keySecret,
      timeoutMs: config.razorpay.timeoutMs,
    }),
    ledger: HttpLedgerClient.create(process.env.LEDGER_SERVICE_URL || 'http://localhost:8004', ledgerToken),
    customers: HttpCustomerClient.create(process.env.CUSTOMER_SERVICE_URL || 'http://localhost:8002', customerToken),
    tokenState: new RedisTokenStateStore(redis),
    redis,
  });
  // Never the secrets: mode, key id (public) and the API host only
  logger.info({ mode: config.mode, keyId: config.razorpay.keyId, apiHost: new URL(config.razorpay.apiBase).host }, 'Razorpay configured');

  // Without Kafka the events stay PENDING and are delivered once it is configured (never marked published)
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'payment-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(outboxPollMs);

  const reconcile = () =>
    void services.reconciler.runScheduled().catch((err) => logger.error({ err, alert: 'PAYMENT_RECONCILIATION_ERROR' }, 'Scheduled reconciliation failed'));
  const firstRun = setTimeout(reconcile, 5_000);
  const reconcileTimer = setInterval(reconcile, reconcileMs);

  startHttpServer(app, process.env.PORT || 8007, 'payment-service', [
    () => clearTimeout(firstRun),
    () => clearInterval(reconcileTimer),
    () => relay?.stop(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'payment-service failed to start');
    process.exit(1);
  });
}
