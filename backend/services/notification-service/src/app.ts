import 'dotenv/config';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  assertNoPlaceholders,
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createMailerFromEnv,
  createEventPublisher,
  errorHandlerMiddleware,
  assertJwtVerificationConfigured,
  KafkaService,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  parsePagination,
  RedisTokenStateStore,
  requireRoles,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
  prismaClientOptions,
} from '@banksphere/common';
import { EmailProvider, MailerEmailProvider } from './providers/email.provider';
import { NotificationService, KafkaDLQPublisher } from './services/notification.service';
import { KafkaNotificationConsumer } from './consumers/kafka-notification.consumer';

const logsQuerySchema = z.object({ recipient: z.string().trim().max(254).optional() });

export interface NotificationAppDeps {
  tokenState: TokenStateStore;
  emailProvider: EmailProvider;
  dlqPublisher?: KafkaDLQPublisher | null;
  redis?: Redis;
  /** When set, /health also reports Kafka consumer liveness */
  kafka?: KafkaService | null;
}

export function createApp(prisma: PrismaClient, deps: NotificationAppDeps) {
  assertJwtVerificationConfigured(); // Fail fast on missing/invalid JWT public keys
  const app = createBaseApp();

  const notificationService = new NotificationService(prisma, deps.emailProvider, deps.dlqPublisher);
  const authenticate = createAuthenticate(deps.tokenState);

  // Notification logs contain customer emails and message bodies: staff only
  app.get(
    '/api/v1/notifications/logs',
    authenticate,
    requireRoles('BANK_ADMIN', 'SUPPORT', 'FRAUD_ANALYST'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { recipient } = logsQuerySchema.parse(req.query);
        const { limit, offset } = parsePagination(req.query);
        const logs = await notificationService.getNotificationLogs(recipient, limit, offset);
        res.json({ success: true, data: logs, pagination: { limit, offset } });
      } catch (error) {
        next(error);
      }
    }
  );

  // Swagger Documentation
  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Notification Service',
      version: '1.0.0',
      description: 'Asynchronous event-driven notification service with idempotency, retries, and DLQ',
      paths: {
        '/api/v1/notifications/logs': {
          get: { summary: 'BANK_ADMIN/SUPPORT: notification audit logs, ?recipient=&limit=&offset=' },
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
        service: 'notification-service',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'notification-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, notificationService, prisma };
}

async function main(): Promise<void> {
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']);
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'notification-service');
  const { app, notificationService } = createApp(prisma, {
    tokenState: new RedisTokenStateStore(redis),
    emailProvider: new MailerEmailProvider(createMailerFromEnv()),
    dlqPublisher: publisher,
    redis,
    kafka,
  });

  if (kafka) new KafkaNotificationConsumer(kafka, notificationService).start();

  startHttpServer(app, process.env.PORT || 8005, 'notification-service', [
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'notification-service failed to start');
    process.exit(1);
  });
}
