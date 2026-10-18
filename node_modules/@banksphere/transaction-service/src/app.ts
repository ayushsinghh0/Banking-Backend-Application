import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
} from '@banksphere/common';
import { LedgerService } from './services/ledger.service';
import { IdempotencyService } from './services/idempotency.service';
import { OutboxService, KafkaPublisher } from './services/outbox.service';
import { TransactionController } from './controllers/transaction.controller';
import { createTransactionRouter } from './routes/transaction.routes';

// Enable JSON.stringify to handle BigInt gracefully
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp(prisma: PrismaClient, kafkaPublisher?: KafkaPublisher) {
  const app = express();
  app.use(express.json());

  // Shared Correlation ID and Request Tracing middleware
  app.use(correlationIdMiddleware);

  // Services initialization
  const ledgerService = new LedgerService(prisma);
  const idempotencyService = new IdempotencyService(prisma);

  // Outbox background service (simulated publisher if none provided)
  const publisher: KafkaPublisher = kafkaPublisher || {
    async publish(topic: string, key: string, payload: any) {
      console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
    },
  };

  const outboxService = new OutboxService(prisma, publisher);
  outboxService.start(3000); // Poll every 3 seconds

  // Controller & Router
  const controller = new TransactionController(ledgerService, idempotencyService);
  app.use('/api/v1/transactions', createTransactionRouter(controller));

  // Health and readiness endpoints
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'UP',
        service: 'transaction-and-ledger-service',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({
        status: 'DOWN',
        database: err.message,
      });
    }
  });

  // Swagger documentation
  setupSwagger(app, {
    title: 'BankSphere - Transaction & Ledger Service',
    version: '1.0.0',
    description: 'Double-entry immutable ledger and financial transaction engine',
    paths: {
      '/api/v1/transactions/transfer': {
        post: {
          summary: 'Transfer funds between accounts',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
        },
      },
    },
  });

  // Centralized Error Handling Middleware
  app.use(errorHandlerMiddleware);

  return { app, outboxService, prisma };
}

// Server startup if executed directly
if (require.main === module) {
  const prisma = new PrismaClient();
  const { app } = createApp(prisma);
  const PORT = process.env.PORT || 8004;

  const server = app.listen(PORT, () => {
    console.log(`BankSphere Transaction & Ledger Service running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down Transaction & Ledger Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Postgres connections closed. Process terminating.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
