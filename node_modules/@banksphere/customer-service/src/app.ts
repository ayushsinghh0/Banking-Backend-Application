import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import Redis from 'ioredis';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
} from '@banksphere/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { createCustomerRouter } from './routes/customer.routes';

export function createApp(prisma: PrismaClient, redisClient?: Redis) {
  const app = express();
  app.use(express.json());

  // Tracing middleware
  app.use(correlationIdMiddleware);

  const redis =
    redisClient ||
    new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
    });

  const customerService = new CustomerService(prisma, redis);
  const customerController = new CustomerController(customerService);

  // Routes
  app.use('/api/v1/customers', createCustomerRouter(customerController));

  // OpenAPI Swagger Docs
  setupSwagger(app, {
    title: 'BankSphere - Customer Service',
    version: '1.0.0',
    description: 'Customer profile management with Redis Cache-Aside and cache invalidation',
    paths: {
      '/api/v1/customers/me': {
        get: {
          summary: 'Retrieve authenticated customer profile',
        },
        patch: {
          summary: 'Update permitted customer profile fields and invalidate cache',
        },
      },
    },
  });

  // Health and Readiness
  app.get('/health', async (_req: Request, res: Response) => {
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
    } catch (err: any) {
      res.status(503).json({
        status: 'DOWN',
        error: err.message,
      });
    }
  });

  // Centralized Error Handler
  app.use(errorHandlerMiddleware);

  return { app, prisma, redis };
}

// Direct server startup
if (require.main === module) {
  const prisma = new PrismaClient();
  const { app, redis } = createApp(prisma);
  const PORT = process.env.PORT || 8002;

  const server = app.listen(PORT, () => {
    console.log(`BankSphere Customer Service running on port ${PORT}`);
  });

  const shutdown = async () => {
    console.log('Shutting down Customer Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      await redis.quit();
      console.log('Customer Service connections closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
