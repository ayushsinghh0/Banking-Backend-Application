import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
  KafkaService,
} from '@banksphere/common';
import { FraudService, KafkaAlertPublisher } from './services/fraud.service';
import { FraudController } from './controllers/fraud.controller';
import { createFraudRouter } from './routes/fraud.routes';
import { KafkaFraudConsumer } from './consumers/kafka-fraud.consumer';

// BigInt JSON serializer
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp(prisma: PrismaClient, alertPublisher?: KafkaAlertPublisher) {
  const app = express();
  app.use(express.json());

  // Tracing middleware
  app.use(correlationIdMiddleware);

  const publisher: KafkaAlertPublisher = alertPublisher || {
    async publish(topic: string, key: string, payload: any) {
      console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
    },
  };

  const fraudService = new FraudService(prisma, publisher);
  const fraudController = new FraudController(fraudService);

  // Routes
  app.use('/api/v1/fraud', createFraudRouter(fraudController));

  // Swagger Documentation
  setupSwagger(app, {
    title: 'BankSphere - Fraud & Risk Service',
    version: '1.0.0',
    description: 'Real-time transaction risk scoring, velocity checks, and automated fraud alerts',
    paths: {
      '/api/v1/fraud/evaluate': {
        post: {
          summary: 'Synchronously evaluate financial transaction risk',
        },
      },
      '/api/v1/fraud/alerts': {
        get: {
          summary: 'Retrieve flagged fraud alerts for compliance review',
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
        service: 'fraud-service',
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

  return { app, fraudService, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const { app, fraudService } = createApp(prisma);
  const PORT = process.env.PORT || 8006;

  const server = app.listen(PORT, async () => {
    console.log(`BankSphere Fraud & Risk Service running on port ${PORT}`);

    // Start Kafka Consumer
    try {
      const kafkaService = new KafkaService({
        clientId: 'fraud-service',
        brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'],
      });
      const consumer = new KafkaFraudConsumer(kafkaService, fraudService);
      await consumer.start();
      console.log('Kafka Fraud Consumer subscribed to transaction.completed.v1');
    } catch (err) {
      console.warn('Kafka Broker not currently reachable, consumer standing by:', err);
    }
  });

  const shutdown = async () => {
    console.log('Shutting down Fraud & Risk Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Fraud Service connections closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
