"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const ioredis_1 = __importDefault(require("ioredis"));
const common_1 = require("@banksphere/common");
const customer_service_1 = require("./services/customer.service");
const customer_controller_1 = require("./controllers/customer.controller");
const customer_routes_1 = require("./routes/customer.routes");
function createApp(prisma, redisClient) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Tracing middleware
    app.use(common_1.correlationIdMiddleware);
    const redis = redisClient ||
        new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379', {
            maxRetriesPerRequest: 2,
        });
    const customerService = new customer_service_1.CustomerService(prisma, redis);
    const customerController = new customer_controller_1.CustomerController(customerService);
    // Routes
    app.use('/api/v1/customers', (0, customer_routes_1.createCustomerRouter)(customerController));
    // OpenAPI Swagger Docs
    (0, common_1.setupSwagger)(app, {
        title: 'BankSphere - Customer Service',
        version: '1.0.0',
        description: 'Customer profile management with Redis Cache-Aside and cache invalidation',
        paths: {
            '/api/v1/customers/me': {
                get: {
                    summary: 'Retrieve authenticated customer profile',
                },
                patch: {
                    summary: 'Update permitted customer profile fields and invalidate cache',
                },
            },
        },
    });
    // Health and Readiness
    app.get('/health', async (_req, res) => {
        try {
            await prisma.$queryRaw `SELECT 1`;
            const redisPong = await redis.ping();
            res.json({
                status: 'UP',
                service: 'customer-service',
                database: 'connected',
                redis: redisPong === 'PONG' ? 'connected' : 'disconnected',
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
    // Centralized Error Handler
    app.use(common_1.errorHandlerMiddleware);
    return { app, prisma, redis };
}
// Direct server startup
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const { app, redis } = createApp(prisma);
    const PORT = process.env.PORT || 8002;
    const server = app.listen(PORT, () => {
        console.log(`BankSphere Customer Service running on port ${PORT}`);
    });
    const shutdown = async () => {
        console.log('Shutting down Customer Service gracefully...');
        server.close(async () => {
            await prisma.$disconnect();
            await redis.quit();
            console.log('Customer Service connections closed.');
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
