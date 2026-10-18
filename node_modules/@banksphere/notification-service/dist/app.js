"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const common_1 = require("@banksphere/common");
const email_provider_1 = require("./providers/email.provider");
const notification_service_1 = require("./services/notification.service");
const kafka_notification_consumer_1 = require("./consumers/kafka-notification.consumer");
function createApp(prisma, emailProvider) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Tracing middleware
    app.use(common_1.correlationIdMiddleware);
    const provider = emailProvider || new email_provider_1.SimulatedEmailProvider();
    const notificationService = new notification_service_1.NotificationService(prisma, provider);
    // Read-only endpoint to inspect notification audit logs
    app.get('/api/v1/notifications/logs', async (req, res) => {
        const recipient = req.query.recipient;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const logs = await notificationService.getNotificationLogs(recipient, limit);
        res.json({ success: true, data: logs });
    });
    // Swagger Documentation
    (0, common_1.setupSwagger)(app, {
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
    app.get('/health', async (_req, res) => {
        try {
            await prisma.$queryRaw `SELECT 1`;
            res.json({
                status: 'UP',
                service: 'notification-service',
                database: 'connected',
                timestamp: new Date().toISOString(),
            });
        }
        catch (err) {
            res.status(503).json({
                status: 'DOWN',
                error: err.message,
            });
        }
    });
    // Centralized Error Handling
    app.use(common_1.errorHandlerMiddleware);
    return { app, notificationService, prisma };
}
// Direct server launch
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const emailProvider = new email_provider_1.SimulatedEmailProvider();
    const { app, notificationService } = createApp(prisma, emailProvider);
    const PORT = process.env.PORT || 8005;
    const server = app.listen(PORT, async () => {
        console.log(`BankSphere Notification Service running on port ${PORT}`);
        // Start Kafka Consumer
        try {
            const kafkaService = new common_1.KafkaService({
                clientId: 'notification-service',
                brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'],
            });
            const consumer = new kafka_notification_consumer_1.KafkaNotificationConsumer(kafkaService, notificationService);
            await consumer.start();
            console.log('Kafka Notification Consumer subscribed to topics');
        }
        catch (err) {
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
