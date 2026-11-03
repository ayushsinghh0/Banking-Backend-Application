import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  acquireJobLease,
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
  prismaClientOptions,
} from '@banksphere/common';
import { AccountService } from './services/account.service';
import { AccountController } from './controllers/account.controller';
import { createAccountRouter } from './routes/account.routes';
import { HttpLedgerClient, LedgerClient } from './clients/ledger.client';
import { CustomerClient, HttpCustomerClient } from './clients/customer.client';
import { AccountListCache } from './services/account-cache';

export interface AccountAppDeps {
  tokenState: TokenStateStore;
  ledgerClient?: LedgerClient;
  customerClient?: CustomerClient;
  redis?: Redis;
  /** Account-list cache on the cache Redis (CACHE_REDIS_URL); none = every list read goes to the database */
  cache?: CacheLike;
}

export function createApp(prisma: PrismaClient, deps: AccountAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  getInternalToken('LEDGER_INTERNAL_TOKEN');
  getInternalToken('CUSTOMER_INTERNAL_TOKEN');
  const app = createBaseApp();

  const accountService = new AccountService(
    prisma,
    deps.ledgerClient ?? new HttpLedgerClient(),
    deps.customerClient ?? new HttpCustomerClient(),
    new AccountListCache(deps.cache)
  );
  const accountController = new AccountController(accountService);

  app.use('/api/v1/accounts', createAccountRouter(accountController, createAuthenticate(deps.tokenState)));

  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Account Service',
      version: '2.0.0',
      description: 'Bank account provisioning (KYC-gated), 12-digit account numbers, lifecycle states and limits',
      paths: {
        '/api/v1/accounts': {
          post: { summary: 'Open an account (requires VERIFIED KYC)' },
          get: { summary: 'List accounts (customers: own; staff: ?customerId=, logged)' },
        },
        '/api/v1/accounts/lookup': {
          get: { summary: 'Staff: identify an account by ?accountNumber= (12 digits); logged' },
        },
        '/api/v1/accounts/{accountId}': {
          get: { summary: 'Get bank account details by ID' },
        },
        '/api/v1/accounts/{accountId}/status': {
          patch: {
            summary:
              'Update account status. Customers may only freeze; BANK_ADMIN may unfreeze or close (zero balance)',
          },
        },
        '/api/v1/accounts/{accountId}/daily-limit': {
          patch: {
            summary:
              'Change the daily outgoing limit (BANK_ADMIN: any value, which becomes the bank ceiling; owner: lower freely, raise up to the customer cap and the bank ceiling)',
          },
        },
      },
    });
  }

  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (deps.redis) await deps.redis.ping();
      res.json({ status: 'UP', service: 'account-service', timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'account-service' });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return { app, prisma, accountService };
}

async function main(): Promise<void> {
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS', 'LEDGER_INTERNAL_TOKEN', 'CUSTOMER_INTERNAL_TOKEN', 'CACHE_REDIS_URL']);
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  // Cache Redis (evictable, never the security store); unset CACHE_REDIS_URL disables caching
  const { cache, redis: cacheRedis } = createCache({ namespace: 'account' });
  const { app, accountService } = createApp(prisma, { tokenState: new RedisTokenStateStore(redis), redis, cache });
  const reconcileIntervalMs = Number(process.env.RECONCILE_INTERVAL_MS || 5 * 60 * 1000);
  const reconcileTimer = setInterval(() => {
    // One replica at a time (lease), not every instance walking every account
    acquireJobLease(prisma, 'account-ledger-reconcile', Math.ceil((reconcileIntervalMs * 2) / 1000))
      .then((leader) => (leader ? accountService.reconcileWithLedger() : undefined))
      .catch((err) => logger.error({ err }, 'Account/ledger reconciliation failed'));
  }, reconcileIntervalMs);

  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'account-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(Number(process.env.OUTBOX_POLL_INTERVAL_MS || 2000));

  startHttpServer(app, process.env.PORT || 8003, 'account-service', [
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
    logger.fatal({ err }, 'account-service failed to start');
    process.exit(1);
  });
}
