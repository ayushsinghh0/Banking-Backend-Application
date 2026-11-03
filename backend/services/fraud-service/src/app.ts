import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  assertNoPlaceholders,
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  assertJwtVerificationConfigured,
  KafkaService,
  OutboxRelay,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
  prismaClientOptions,
} from '@banksphere/common';
import { FraudService } from './services/fraud.service';
import { FraudController } from './controllers/fraud.controller';
import { createFraudRouter } from './routes/fraud.routes';
import { KafkaFraudConsumer } from './consumers/kafka-fraud.consumer';

// BigInt JSON serializer (risk assessments carry amounts as BigInt)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export interface FraudAppDeps {
  tokenState: TokenStateStore;
  redis?: Redis;
  /** When set, /health also reports Kafka consumer liveness */
  kafka?: KafkaService | null;
}

export function createApp(prisma: PrismaClient, deps: FraudAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  const app = createBaseApp();

  const fraudService = new FraudService(prisma);
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
      if (deps.kafka && !deps.kafka.consumersHealthy()) throw new Error('Kafka consumer is not running');
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
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS']);
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'fraud-service');
  const { app, fraudService } = createApp(prisma, {
    tokenState: new RedisTokenStateStore(redis),
    redis,
    kafka,
  });

  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000));
  if (kafka) new KafkaFraudConsumer(kafka, fraudService).start();

  startHttpServer(app, process.env.PORT || 8006, 'fraud-service', [
    () => relay?.stop(),
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
