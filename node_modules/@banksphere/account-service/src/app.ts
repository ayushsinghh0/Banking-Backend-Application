import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
} from '@banksphere/common';
import { AccountService, KafkaPublisher } from './services/account.service';
import { AccountController } from './controllers/account.controller';
import { createAccountRouter } from './routes/account.routes';

// BigInt JSON serializer
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp(prisma: PrismaClient, kafkaPublisher?: KafkaPublisher) {
  const app = express();
  app.use(express.json());

  // Tracing middleware
  app.use(correlationIdMiddleware);

  // Simulated Kafka publisher if none injected
  const publisher: KafkaPublisher = kafkaPublisher || {
    async publish(topic: string, key: string, payload: any) {
      console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
    },
  };

  const accountService = new AccountService(prisma, publisher);
  const accountController = new AccountController(accountService);

  // Routes
  app.use('/api/v1/accounts', createAccountRouter(accountController));

  // OpenAPI Swagger Docs
  setupSwagger(app, {
    title: 'BankSphere - Account Service',
    version: '1.0.0',
    description: 'Bank account provisioning, 12-digit account number generation, and lifecycle states',
    paths: {
      '/api/v1/accounts': {
        post: {
          summary: 'Provision a new bank account for authenticated customer',
        },
        get: {
          summary: 'List all accounts owned by authenticated customer',
        },
      },
      '/api/v1/accounts/{accountId}': {
        get: {
          summary: 'Get bank account details by ID',
        },
      },
      '/api/v1/accounts/{accountId}/status': {
        patch: {
          summary: 'Update account status (ACTIVE, FROZEN, CLOSED)',
        },
      },
    },
  });

  // Health and Readiness
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'UP',
        service: 'account-service',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({
        status: 'DOWN',
        error: err.message,
      });
    }
  });

  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const { app } = createApp(prisma);
  const PORT = process.env.PORT || 8003;

  const server = app.listen(PORT, () => {
    console.log(`BankSphere Account Service running on port ${PORT}`);
  });

  const shutdown = async () => {
    console.log('Shutting down Account Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Account Service connections closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
