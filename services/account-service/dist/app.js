"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const common_1 = require("@banksphere/common");
const account_service_1 = require("./services/account.service");
const account_controller_1 = require("./controllers/account.controller");
const account_routes_1 = require("./routes/account.routes");
// BigInt JSON serializer
BigInt.prototype.toJSON = function () {
    return this.toString();
};
function createApp(prisma, kafkaPublisher) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Tracing middleware
    app.use(common_1.correlationIdMiddleware);
    // Simulated Kafka publisher if none injected
    const publisher = kafkaPublisher || {
        async publish(topic, key, payload) {
            console.log(`[KafkaPublisher SIMULATED] Topic: ${topic} | Key: ${key}`, JSON.stringify(payload));
        },
    };
    const accountService = new account_service_1.AccountService(prisma, publisher);
    const accountController = new account_controller_1.AccountController(accountService);
    // Routes
    app.use('/api/v1/accounts', (0, account_routes_1.createAccountRouter)(accountController));
    // OpenAPI Swagger Docs
    (0, common_1.setupSwagger)(app, {
        title: 'BankSphere - Account Service',
        version: '1.0.0',
        description: 'Bank account provisioning, 12-digit account number generation, and lifecycle states',
        paths: {
            '/api/v1/accounts': {
                post: {
                    summary: 'Provision a new bank account for authenticated customer',
                },
                get: {
                    summary: 'List all accounts owned by authenticated customer',
                },
            },
            '/api/v1/accounts/{accountId}': {
                get: {
                    summary: 'Get bank account details by ID',
                },
            },
            '/api/v1/accounts/{accountId}/status': {
                patch: {
                    summary: 'Update account status (ACTIVE, FROZEN, CLOSED)',
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
                service: 'account-service',
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
    return { app, prisma };
}
// Direct server launch
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const { app } = createApp(prisma);
    const PORT = process.env.PORT || 8003;
    const server = app.listen(PORT, () => {
        console.log(`BankSphere Account Service running on port ${PORT}`);
    });
    const shutdown = async () => {
        console.log('Shutting down Account Service gracefully...');
        server.close(async () => {
            await prisma.$disconnect();
            console.log('Account Service connections closed.');
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
