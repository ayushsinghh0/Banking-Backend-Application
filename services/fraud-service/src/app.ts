import 'dotenv/config';
import { Request, Response } from 'express';
import { PrismaClient } from '../generated/client';
import {
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  setupSwagger,
} from '@banksphere/common';
import { FraudService, KafkaAlertPublisher } from './services/fraud.service';
import { FraudController } from './controllers/fraud.controller';
import { createFraudRouter } from './routes/fraud.routes';
import { KafkaFraudConsumer } from './consumers/kafka-fraud.consumer';

// BigInt JSON serializer (risk assessments carry amounts as BigInt)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp(prisma: PrismaClient, alertPublisher?: KafkaAlertPublisher | null) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const fraudService = new FraudService(prisma, alertPublisher ?? undefined);
  const fraudController = new FraudController(fraudService);

  // Routes
  app.use('/api/v1/fraud', createFraudRouter(fraudController));

  // Swagger Documentation
  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Fraud & Risk Service',
      version: '1.0.0',
      description: 'Real-time transaction risk scoring, velocity checks, and automated fraud alerts (staff only)',
      paths: {
        '/api/v1/fraud/evaluate': {
          post: { summary: 'Synchronously evaluate financial transaction risk' },
        },
        '/api/v1/fraud/alerts': {
          get: { summary: 'Retrieve flagged fraud alerts, ?status=&limit=&offset=' },
        },
        '/api/v1/fraud/alerts/{alertId}': {
          patch: { summary: 'Triage an alert (OPEN, UNDER_REVIEW, RESOLVED, DISMISSED)' },
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
        service: 'fraud-service',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'fraud-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, fraudService, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'fraud-service');
  const { app, fraudService } = createApp(prisma, publisher);
  const PORT = process.env.PORT || 8006;
  let consumer: KafkaFraudConsumer | null = null;

  const server = app.listen(PORT, async () => {
    logger.info(`BankSphere Fraud & Risk Service running on port ${PORT}`);

    if (!kafka) return;
    try {
      consumer = new KafkaFraudConsumer(kafka, fraudService);
      await consumer.start();
      logger.info('Kafka Fraud Consumer subscribed to transaction.completed.v1');
    } catch (err) {
      logger.error({ err }, 'Kafka broker not reachable; fraud consumer not started');
    }
  });

  const shutdown = async () => {
    logger.info('Shutting down Fraud & Risk Service gracefully...');
    server.close(async () => {
      await consumer?.stop().catch(() => {});
      await kafka?.disconnect().catch(() => {});
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
