import 'dotenv/config';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createMailerFromEnv,
  createEventPublisher,
  errorHandlerMiddleware,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  parsePagination,
  RedisTokenStateStore,
  requireRoles,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
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
}

export function createApp(prisma: PrismaClient, deps: NotificationAppDeps) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const notificationService = new NotificationService(prisma, deps.emailProvider, deps.dlqPublisher);
  const authenticate = createAuthenticate(deps.tokenState);

  // Notification logs contain customer emails and message bodies: staff only
  app.get(
    '/api/v1/notifications/logs',
    authenticate,
    requireRoles('BANK_ADMIN', 'SUPPORT'),
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
  const prisma = new PrismaClient();
  const redis = await connectRedis();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'notification-service');
  const { app, notificationService } = createApp(prisma, {
    tokenState: new RedisTokenStateStore(redis),
    emailProvider: new MailerEmailProvider(createMailerFromEnv()),
    dlqPublisher: publisher,
    redis,
  });

  let consumer: KafkaNotificationConsumer | null = null;
  if (kafka) {
    consumer = new KafkaNotificationConsumer(kafka, notificationService);
    // Kafka being unavailable must not take the API down; KafkaJS keeps retrying the connection
    consumer.start().catch((err) => logger.error({ err }, 'Notification consumer failed to start'));
  }

  startHttpServer(app, process.env.PORT || 8005, 'notification-service', [
    () => consumer?.stop(),
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
