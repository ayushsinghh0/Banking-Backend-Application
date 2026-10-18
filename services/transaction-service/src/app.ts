import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  getInternalServiceToken,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  OutboxRelay,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
} from '@banksphere/common';
import { LedgerService } from './services/ledger.service';
import { IdempotencyService } from './services/idempotency.service';
import { TransactionController } from './controllers/transaction.controller';
import { createTransactionRouter } from './routes/transaction.routes';
import { createInternalRouter } from './routes/internal.routes';

export interface TransactionAppDeps {
  tokenState: TokenStateStore;
  redis?: Redis;
}

export function createApp(prisma: PrismaClient, deps: TransactionAppDeps) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  getInternalServiceToken();
  const app = createBaseApp();

  // Services initialization
  const ledgerService = new LedgerService(prisma);
  const idempotencyService = new IdempotencyService(prisma);

  // Controller & Router
  const controller = new TransactionController(ledgerService, idempotencyService);
  app.use('/api/v1/transactions', createTransactionRouter(controller, createAuthenticate(deps.tokenState)));
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

  return { app, idempotencyService, prisma };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const redis = await connectRedis();
  const { app, idempotencyService } = createApp(prisma, { tokenState: new RedisTokenStateStore(redis), redis });

  // The relay only runs with a real publisher. Without Kafka, events stay PENDING and are
  // delivered once Kafka is configured, instead of being marked PUBLISHED and lost.
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'transaction-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(Number(process.env.OUTBOX_POLL_INTERVAL_MS || 2000));

  const purgeTimer = setInterval(() => {
    idempotencyService.purgeExpired().catch((err) => logger.error({ err }, 'Idempotency purge failed'));
  }, 60 * 60 * 1000);

  startHttpServer(app, process.env.PORT || 8004, 'transaction-service', [
    () => clearInterval(purgeTimer),
    () => relay?.stop(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'transaction-service failed to start');
    process.exit(1);
  });
}
