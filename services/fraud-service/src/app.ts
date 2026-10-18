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
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
} from '@banksphere/common';
import { FraudService, KafkaAlertPublisher } from './services/fraud.service';
import { FraudController } from './controllers/fraud.controller';
import { createFraudRouter } from './routes/fraud.routes';
import { KafkaFraudConsumer } from './consumers/kafka-fraud.consumer';

// BigInt JSON serializer (risk assessments carry amounts as BigInt)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export interface FraudAppDeps {
  tokenState: TokenStateStore;
  alertPublisher?: KafkaAlertPublisher | null;
  redis?: Redis;
}

export function createApp(prisma: PrismaClient, deps: FraudAppDeps) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const fraudService = new FraudService(prisma, deps.alertPublisher ?? undefined);
  const fraudController = new FraudController(fraudService);

  // Routes
  app.use('/api/v1/fraud', createFraudRouter(fraudController, createAuthenticate(deps.tokenState)));

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
      if (deps.redis) await deps.redis.ping();
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

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const redis = await connectRedis();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'fraud-service');
  const { app, fraudService } = createApp(prisma, {
    tokenState: new RedisTokenStateStore(redis),
    alertPublisher: publisher,
    redis,
  });

  let consumer: KafkaFraudConsumer | null = null;
  if (kafka) {
    consumer = new KafkaFraudConsumer(kafka, fraudService);
    // Kafka being unavailable must not take the API down; KafkaJS keeps retrying the connection
    consumer.start().catch((err) => logger.error({ err }, 'Fraud consumer failed to start'));
  }

  startHttpServer(app, process.env.PORT || 8006, 'fraud-service', [
    () => consumer?.stop(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'fraud-service failed to start');
    process.exit(1);
  });
}
