import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  assertNoPlaceholders,
  CacheLike,
  connectRedis,
  createCache,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  assertJwtVerificationConfigured,
  getInternalToken,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  OutboxRelay,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
  NoopCache,
  prismaClientOptions,
} from '@banksphere/common';
import { LedgerService } from './services/ledger.service';
import { TellerService } from './services/teller.service';
import { BeneficiaryService } from './services/beneficiary.service';
import { IdempotencyService } from './services/idempotency.service';
import { defaultLedgerPolicy, envNumber } from './services/ledger-core';
import { TransactionController } from './controllers/transaction.controller';
import { createTransactionRouter } from './routes/transaction.routes';
import { createInternalRouter } from './routes/internal.routes';
import { createPaymentInternalRouter, PAYMENT_LEDGER_TOKEN_ENV } from './routes/payment-internal.routes';
import { LedgerReadCache } from './services/ledger-cache';
import { LedgerCommits } from './services/ledger-commits';
import { PaymentLedgerService } from './services/payment-ledger.service';
import { AuditChainService } from './services/audit-chain';

export interface TransactionAppDeps {
  tokenState: TokenStateStore;
  redis?: Redis;
  /** Read cache on the cache Redis (CACHE_REDIS_URL); none = every read goes to the database */
  cache?: CacheLike;
}

export function createApp(prisma: PrismaClient, deps: TransactionAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  getInternalToken('LEDGER_INTERNAL_TOKEN');
  getInternalToken(PAYMENT_LEDGER_TOKEN_ENV);
  const app = createBaseApp();

  // Services initialization (an invalid policy setting stops the service here, at startup)
  const policy = defaultLedgerPolicy();
  // One commit tracker for every posting path: cache versions are bumped (and postings counted) after commit
  const commits = new LedgerCommits(new LedgerReadCache(deps.cache ?? new NoopCache()));
  const ledgerService = new LedgerService(prisma, policy, commits);
  const idempotencyService = new IdempotencyService(prisma, undefined, commits);
  const paymentLedgerService = new PaymentLedgerService(prisma, commits);

  // Controller & Router
  const tellerService = new TellerService(prisma, policy, commits);
  const controller = new TransactionController(
    ledgerService,
    tellerService,
    new BeneficiaryService(prisma, policy),
    idempotencyService,
    new AuditChainService(prisma)
  );
  app.use('/api/v1/transactions', createTransactionRouter(controller, createAuthenticate(deps.tokenState)));
  // The payments router is mounted first: the account-lifecycle router below guards everything under
  // /internal/v1 with LEDGER_INTERNAL_TOKEN, and each caller holds only its own credential
  app.use('/internal/v1/payments', createPaymentInternalRouter(paymentLedgerService));
  app.use('/internal/v1', createInternalRouter(ledgerService));

  // Health and readiness endpoints
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (deps.redis) await deps.redis.ping();
      res.json({
        status: 'UP',
        service: 'transaction-and-ledger-service',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'transaction-and-ledger-service' });
    }
  });

  // Swagger documentation
  if (isSwaggerEnabled()) {
    const idempotencyHeader = {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
    };
    setupSwagger(app, {
      title: 'BankSphere - Transaction & Ledger Service',
      version: '1.0.0',
      description: 'Double-entry immutable ledger and financial transaction engine',
      paths: {
        '/api/v1/transactions/transfer': {
          post: { summary: 'Transfer funds from an owned account', parameters: [idempotencyHeader] },
        },
        '/api/v1/transactions/withdraw': {
          post: { summary: 'Withdraw from an owned account', parameters: [idempotencyHeader] },
        },
        '/api/v1/transactions/deposit': {
          post: { summary: 'BANK_ADMIN (teller) only: deposit into an account', parameters: [idempotencyHeader] },
        },
        '/api/v1/transactions/accounts/{accountId}/balance': {
          get: { summary: 'Authoritative ledger balance (owner or staff)' },
        },
        '/api/v1/transactions/accounts/{accountId}/history': {
          get: { summary: 'Paginated ledger history (owner or staff), ?limit=1..100&offset=' },
        },
      },
    });
  }

  app.use(notFoundHandler);
  // Centralized Error Handling Middleware
  app.use(errorHandlerMiddleware);

  return { app, idempotencyService, ledgerService, tellerService, paymentLedgerService, prisma };
}

async function main(): Promise<void> {
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS', 'LEDGER_INTERNAL_TOKEN', PAYMENT_LEDGER_TOKEN_ENV, 'CACHE_REDIS_URL']);
  // Read (and validated) before anything starts: a NaN interval would make setInterval fire every millisecond
  const outboxPollMs = envNumber('OUTBOX_POLL_INTERVAL_MS', 2000, 100);
  const reconcileIntervalMs = envNumber('RECONCILE_INTERVAL_MS', 10 * 60 * 1000, 1000);
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  // Cache Redis (evictable, never the security store); unset CACHE_REDIS_URL disables caching
  const { cache, redis: cacheRedis } = createCache({ namespace: 'ledger' });
  const { app, idempotencyService, ledgerService, tellerService, paymentLedgerService } = createApp(prisma, {
    tokenState: new RedisTokenStateStore(redis),
    redis,
    cache,
  });
  // The migration creates PAYMENT_CLEARING; this makes sure (idempotently) before the first top-up
  await paymentLedgerService.ensureClearingAccount();

  // The relay only runs with a real publisher. Without Kafka, events stay PENDING and are
  // delivered once Kafka is configured, instead of being marked PUBLISHED and lost.
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'transaction-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(outboxPollMs);

  const purgeTimer = setInterval(() => {
    idempotencyService.purgeExpired().catch((err) => logger.error({ err }, 'Idempotency purge failed'));
    tellerService.expireStaleApprovals().catch((err) => logger.error({ err }, 'Cash approval expiry failed'));
  }, 60 * 60 * 1000);
  // Ledger invariant: balances must equal the net of their entries (alerts on mismatch)
  // One replica at a time (lease): the full scan runs once per interval for the whole deployment
  const reconcile = () => ledgerService.runScheduledReconciliation(Math.ceil((reconcileIntervalMs * 2) / 1000));
  void reconcile();
  const reconcileTimer = setInterval(reconcile, reconcileIntervalMs);

  startHttpServer(app, process.env.PORT || 8004, 'transaction-service', [
    () => clearInterval(purgeTimer),
    () => clearInterval(reconcileTimer),
    () => relay?.stop(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
    () => cacheRedis?.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'transaction-service failed to start');
    process.exit(1);
  });
}
