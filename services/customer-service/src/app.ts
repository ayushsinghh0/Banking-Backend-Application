import 'dotenv/config';
import { Request, Response } from 'express';
import { PrismaClient } from '../generated/client';
import Redis from 'ioredis';
import {
  connectRedis,
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

export function createApp(prisma: PrismaClient, redis: Redis, tokenState: TokenStateStore) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  getInternalToken('CUSTOMER_INTERNAL_TOKEN');
  const app = createBaseApp();

  const customerService = new CustomerService(
    prisma,
    redis,
    Number(process.env.PROFILE_CACHE_TTL_SECONDS || 1800)
  );
  const customerController = new CustomerController(customerService);

  // Routes
  app.use('/api/v1/customers', createCustomerRouter(customerController, createAuthenticate(tokenState)));
  app.use('/internal/v1', createInternalCustomerRouter(customerService));

  // OpenAPI Swagger Docs
  if (isSwaggerEnabled()) setupSwagger(app, {
    title: 'BankSphere - Customer Service',
    version: '1.0.0',
    description: 'Customer profile management with Redis Cache-Aside and cache invalidation',
    paths: {
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
        patch: { summary: 'BANK_ADMIN: set KYC status (PENDING, VERIFIED, REJECTED)' },
      },
    },
  });

  // Health and Readiness
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redisPong = await redis.ping();
      res.json({
        status: 'UP',
        service: 'customer-service',
        database: 'connected',
        redis: redisPong === 'PONG' ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'customer-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handler
  app.use(errorHandlerMiddleware);

  return { app, prisma, redis };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  const { app } = createApp(prisma, redis, new RedisTokenStateStore(redis));
  startHttpServer(app, process.env.PORT || 8002, 'customer-service', [
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'customer-service failed to start');
    process.exit(1);
  });
}
