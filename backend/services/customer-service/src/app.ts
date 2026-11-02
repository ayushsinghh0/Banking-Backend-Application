import 'dotenv/config';
import { Request, Response } from 'express';
import { PrismaClient } from '../generated/client';
import Redis from 'ioredis';
import {
  assertNoPlaceholders,
  CacheLike,
  connectRedis,
  createCache,
  createAuthenticate,
  createBaseApp,
  errorHandlerMiddleware,
  assertJwtVerificationConfigured,
  getInternalToken,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
  prismaClientOptions,
} from '@banksphere/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { createCustomerRouter, createInternalCustomerRouter } from './routes/customer.routes';
import { CustomerCache } from './services/customer-cache';

export interface CustomerAppDeps {
  tokenState: TokenStateStore;
  /** Security Redis (token state); checked by /health when given */
  redis?: Redis;
  /** Profile and KYC cache on the cache Redis (CACHE_REDIS_URL); none = every read goes to the database */
  cache?: CacheLike;
}

export function createApp(prisma: PrismaClient, deps: CustomerAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  getInternalToken('CUSTOMER_INTERNAL_TOKEN');
  const app = createBaseApp();

  const customerService = new CustomerService(prisma, new CustomerCache(deps.cache));
  const customerController = new CustomerController(customerService);

  // Routes
  app.use('/api/v1/customers', createCustomerRouter(customerController, createAuthenticate(deps.tokenState)));
  app.use('/internal/v1', createInternalCustomerRouter(customerService));

  // OpenAPI Swagger Docs
  if (isSwaggerEnabled()) setupSwagger(app, {
    title: 'BankSphere - Customer Service',
    version: '1.0.0',
    description: 'Customer profiles and KYC review, with a versioned read-through cache',
    paths: {
      '/api/v1/customers': {
        get: {
          summary:
            'KYC_OFFICER/BANK_ADMIN/SUPPORT: search profiles (?kycStatus=&q=&limit=&offset=; PENDING oldest first); logged',
        },
      },
      '/api/v1/customers/me': {
        get: {
          summary: 'Retrieve authenticated customer profile',
        },
        post: {
          summary: 'Create the authenticated customer profile',
        },
        patch: {
          summary: 'Update permitted customer profile fields and invalidate cache',
        },
      },
      '/api/v1/customers/{userId}': {
        get: { summary: 'BANK_ADMIN/SUPPORT: look up a customer profile' },
      },
      '/api/v1/customers/{userId}/kyc': {
        patch: { summary: 'KYC_OFFICER: decide KYC (PENDING, VERIFIED, REJECTED) on the reviewed profile version' },
      },
      '/api/v1/customers/{userId}/kyc/history': {
        get: { summary: 'KYC_OFFICER/BANK_ADMIN/SUPPORT: KYC decisions and identity changes; logged' },
      },
    },
  });

  // Health and Readiness
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (deps.redis) await deps.redis.ping();
      res.json({ status: 'UP', service: 'customer-service', timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'customer-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handler
  app.use(errorHandlerMiddleware);

  return { app, prisma, customerService };
}

async function main(): Promise<void> {
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'JWT_VERIFY_KEYS', 'CUSTOMER_INTERNAL_TOKEN', 'CACHE_REDIS_URL']);
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  // Cache Redis (evictable, never the security store); unset CACHE_REDIS_URL disables caching
  const { cache, redis: cacheRedis } = createCache({ namespace: 'customer' });
  const { app } = createApp(prisma, { tokenState: new RedisTokenStateStore(redis), redis, cache });
  startHttpServer(app, process.env.PORT || 8002, 'customer-service', [
    () => prisma.$disconnect(),
    () => redis.quit(),
    () => cacheRedis?.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'customer-service failed to start');
    process.exit(1);
  });
}
