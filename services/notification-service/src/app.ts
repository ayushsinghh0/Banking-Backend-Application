import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
  KafkaService,
} from '@banksphere/common';
import { SimulatedEmailProvider } from './providers/email.provider';
import { NotificationService } from './services/notification.service';
import { KafkaNotificationConsumer } from './consumers/kafka-notification.consumer';

export function createApp(prisma: PrismaClient, emailProvider?: SimulatedEmailProvider) {
  const app = express();
  app.use(express.json());

  // Tracing middleware
  app.use(correlationIdMiddleware);

  const provider = emailProvider || new SimulatedEmailProvider();
  const notificationService = new NotificationService(prisma, provider);

  // Read-only endpoint to inspect notification audit logs
  app.get('/api/v1/notifications/logs', async (req: Request, res: Response) => {
    const recipient = req.query.recipient as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const logs = await notificationService.getNotificationLogs(recipient, limit);
    res.json({ success: true, data: logs });
  });

  // Swagger Documentation
  setupSwagger(app, {
    title: 'BankSphere - Notification Service',
    version: '1.0.0',
    description: 'Asynchronous event-driven notification service with idempotency, retries, and DLQ',
    paths: {
      '/api/v1/notifications/logs': {
        get: {
          summary: 'Retrieve notification audit logs',
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
        service: 'notification-service',
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

  return { app, notificationService, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const emailProvider = new SimulatedEmailProvider();
  const { app, notificationService } = createApp(prisma, emailProvider);
  const PORT = process.env.PORT || 8005;

  const server = app.listen(PORT, async () => {
    console.log(`BankSphere Notification Service running on port ${PORT}`);

    // Start Kafka Consumer
    try {
      const kafkaService = new KafkaService({
        clientId: 'notification-service',
        brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'],
      });
      const consumer = new KafkaNotificationConsumer(kafkaService, notificationService);
      await consumer.start();
      console.log('Kafka Notification Consumer subscribed to topics');
    } catch (err) {
      console.warn('Kafka Broker not currently reachable, consumer standing by:', err);
    }
  });

  const shutdown = async () => {
    console.log('Shutting down Notification Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Notification Service connections closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
