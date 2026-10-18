"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const common_1 = require("@banksphere/common");
const fraud_service_1 = require("./services/fraud.service");
const fraud_controller_1 = require("./controllers/fraud.controller");
const fraud_routes_1 = require("./routes/fraud.routes");
const kafka_fraud_consumer_1 = require("./consumers/kafka-fraud.consumer");
// BigInt JSON serializer
BigInt.prototype.toJSON = function () {
    return this.toString();
};
function createApp(prisma, alertPublisher) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Tracing middleware
    app.use(common_1.correlationIdMiddleware);
    const publisher = alertPublisher || {
        async publish(topic, key, payload) {
            console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
        },
    };
    const fraudService = new fraud_service_1.FraudService(prisma, publisher);
    const fraudController = new fraud_controller_1.FraudController(fraudService);
    // Routes
    app.use('/api/v1/fraud', (0, fraud_routes_1.createFraudRouter)(fraudController));
    // Swagger Documentation
    (0, common_1.setupSwagger)(app, {
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
    app.get('/health', async (_req, res) => {
        try {
            await prisma.$queryRaw `SELECT 1`;
            res.json({
                status: 'UP',
                service: 'fraud-service',
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
    return { app, fraudService, prisma };
}
// Direct server launch
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const { app, fraudService } = createApp(prisma);
    const PORT = process.env.PORT || 8006;
    const server = app.listen(PORT, async () => {
        console.log(`BankSphere Fraud & Risk Service running on port ${PORT}`);
        // Start Kafka Consumer
        try {
            const kafkaService = new common_1.KafkaService({
                clientId: 'fraud-service',
                brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'],
            });
            const consumer = new kafka_fraud_consumer_1.KafkaFraudConsumer(kafkaService, fraudService);
            await consumer.start();
            console.log('Kafka Fraud Consumer subscribed to transaction.completed.v1');
        }
        catch (err) {
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
