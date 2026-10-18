import 'dotenv/config';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PrismaClient } from '../generated/client';
import {
  authenticate,
  createBaseApp,
  createEventPublisher,
  errorHandlerMiddleware,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  parsePagination,
  requireRoles,
  setupSwagger,
} from '@banksphere/common';
import { EmailProvider, SimulatedEmailProvider } from './providers/email.provider';
import { NotificationService, KafkaDLQPublisher } from './services/notification.service';
import { KafkaNotificationConsumer } from './consumers/kafka-notification.consumer';

const logsQuerySchema = z.object({ recipient: z.string().trim().max(254).optional() });

export function createApp(
  prisma: PrismaClient,
  emailProvider?: EmailProvider,
  dlqPublisher?: KafkaDLQPublisher | null
) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const provider = emailProvider || new SimulatedEmailProvider();
  const notificationService = new NotificationService(prisma, provider, dlqPublisher);

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

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'notification-service');
  const { app, notificationService } = createApp(prisma, new SimulatedEmailProvider(), publisher);
  const PORT = process.env.PORT || 8005;
  let consumer: KafkaNotificationConsumer | null = null;

  const server = app.listen(PORT, async () => {
    logger.info(`BankSphere Notification Service running on port ${PORT}`);

    if (!kafka) return;
    try {
      consumer = new KafkaNotificationConsumer(kafka, notificationService);
      await consumer.start();
      logger.info('Kafka Notification Consumer subscribed to topics');
    } catch (err) {
      logger.error({ err }, 'Kafka broker not reachable; notification consumer not started');
    }
  });

  const shutdown = async () => {
    logger.info('Shutting down Notification Service gracefully...');
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
