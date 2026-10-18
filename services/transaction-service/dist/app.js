"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const common_1 = require("@banksphere/common");
const ledger_service_1 = require("./services/ledger.service");
const idempotency_service_1 = require("./services/idempotency.service");
const outbox_service_1 = require("./services/outbox.service");
const transaction_controller_1 = require("./controllers/transaction.controller");
const transaction_routes_1 = require("./routes/transaction.routes");
// Enable JSON.stringify to handle BigInt gracefully
BigInt.prototype.toJSON = function () {
    return this.toString();
};
function createApp(prisma, kafkaPublisher) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Shared Correlation ID and Request Tracing middleware
    app.use(common_1.correlationIdMiddleware);
    // Services initialization
    const ledgerService = new ledger_service_1.LedgerService(prisma);
    const idempotencyService = new idempotency_service_1.IdempotencyService(prisma);
    // Outbox background service (simulated publisher if none provided)
    const publisher = kafkaPublisher || {
        async publish(topic, key, payload) {
            console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
        },
    };
    const outboxService = new outbox_service_1.OutboxService(prisma, publisher);
    outboxService.start(3000); // Poll every 3 seconds
    // Controller & Router
    const controller = new transaction_controller_1.TransactionController(ledgerService, idempotencyService);
    app.use('/api/v1/transactions', (0, transaction_routes_1.createTransactionRouter)(controller));
    // Health and readiness endpoints
    app.get('/health', async (_req, res) => {
        try {
            await prisma.$queryRaw `SELECT 1`;
            res.json({
                status: 'UP',
                service: 'transaction-and-ledger-service',
                timestamp: new Date().toISOString(),
            });
        }
        catch (err) {
            res.status(503).json({
                status: 'DOWN',
                database: err.message,
            });
        }
    });
    // Swagger documentation
    (0, common_1.setupSwagger)(app, {
        title: 'BankSphere - Transaction & Ledger Service',
        version: '1.0.0',
        description: 'Double-entry immutable ledger and financial transaction engine',
        paths: {
            '/api/v1/transactions/transfer': {
                post: {
                    summary: 'Transfer funds between accounts',
                    parameters: [
                        {
                            name: 'Idempotency-Key',
                            in: 'header',
                            required: true,
                            schema: { type: 'string' },
                        },
                    ],
                },
            },
        },
    });
    // Centralized Error Handling Middleware
    app.use(common_1.errorHandlerMiddleware);
    return { app, outboxService, prisma };
}
// Server startup if executed directly
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const { app } = createApp(prisma);
    const PORT = process.env.PORT || 8004;
    const server = app.listen(PORT, () => {
        console.log(`BankSphere Transaction & Ledger Service running on port ${PORT}`);
    });
    // Graceful shutdown
    const shutdown = async () => {
        console.log('Shutting down Transaction & Ledger Service gracefully...');
        server.close(async () => {
            await prisma.$disconnect();
            console.log('Postgres connections closed. Process terminating.');
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
