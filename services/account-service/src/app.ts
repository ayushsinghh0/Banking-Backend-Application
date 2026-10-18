import 'dotenv/config';
import { Request, Response } from 'express';
import { PrismaClient } from '../generated/client';
import {
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  getInternalServiceToken,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  setupSwagger,
} from '@banksphere/common';
import { AccountService, KafkaPublisher } from './services/account.service';
import { AccountController } from './controllers/account.controller';
import { createAccountRouter } from './routes/account.routes';
import { HttpLedgerClient, LedgerClient } from './clients/ledger.client';

export interface AccountAppOptions {
  kafkaPublisher?: KafkaPublisher | null;
  ledgerClient?: LedgerClient;
}

export function createApp(prisma: PrismaClient, options: AccountAppOptions = {}) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const ledgerClient = options.ledgerClient ?? (getInternalServiceToken(), new HttpLedgerClient());
  const accountService = new AccountService(prisma, ledgerClient, options.kafkaPublisher);
  const accountController = new AccountController(accountService);

  // Routes
  app.use('/api/v1/accounts', createAccountRouter(accountController));

  // OpenAPI Swagger Docs
  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Account Service',
      version: '1.0.0',
      description: 'Bank account provisioning, 12-digit account number generation, and lifecycle states',
      paths: {
        '/api/v1/accounts': {
          post: { summary: 'Provision a new bank account for authenticated customer' },
          get: { summary: 'List accounts (customers: own; staff: ?customerId=)' },
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
          patch: { summary: 'Change the daily outgoing limit (customers capped, BANK_ADMIN unrestricted)' },
        },
      },
    });
  }

  // Health and Readiness
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'UP',
        service: 'account-service',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'account-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'account-service');
  const { app } = createApp(prisma, { kafkaPublisher: publisher });
  const PORT = process.env.PORT || 8003;

  const server = app.listen(PORT, () => {
    logger.info(`BankSphere Account Service running on port ${PORT}`);
  });

  const shutdown = async () => {
    logger.info('Shutting down Account Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      await kafka?.disconnect().catch(() => {});
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
