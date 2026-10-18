"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const client_1 = require("./generated/client");
const common_1 = require("@banksphere/common");
const token_service_1 = require("./services/token.service");
const auth_service_1 = require("./services/auth.service");
const auth_controller_1 = require("./controllers/auth.controller");
const auth_routes_1 = require("./routes/auth.routes");
function createApp(prisma) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Tracing & Contextual Logger
    app.use(common_1.correlationIdMiddleware);
    // Service dependencies
    const tokenService = new token_service_1.TokenService();
    const authService = new auth_service_1.AuthService(prisma, tokenService);
    const authController = new auth_controller_1.AuthController(authService);
    // Mount API Routes
    app.use('/api/v1/auth', (0, auth_routes_1.createAuthRouter)(authController));
    // OpenAPI Swagger Documentation
    (0, common_1.setupSwagger)(app, {
        title: 'BankSphere - Authentication Service',
        version: '1.0.0',
        description: 'User registration, Argon2id password verification, and JWT refresh token rotation',
        paths: {
            '/api/v1/auth/register': {
                post: {
                    summary: 'Register a new customer or administrator',
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['email', 'password'],
                                    properties: {
                                        email: { type: 'string', format: 'email' },
                                        password: { type: 'string', minLength: 8 },
                                        role: { type: 'string', enum: ['CUSTOMER', 'BANK_ADMIN', 'SUPPORT'] },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            '/api/v1/auth/login': {
                post: {
                    summary: 'Authenticate credentials and obtain token pair',
                },
            },
            '/api/v1/auth/refresh': {
                post: {
                    summary: 'Rotate refresh token and obtain fresh access token',
                },
            },
            '/api/v1/auth/logout': {
                post: {
                    summary: 'Revoke active refresh token session',
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
                service: 'auth-service',
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
    // Centralized Error Handling
    app.use(common_1.errorHandlerMiddleware);
    return { app, prisma };
}
// Direct server launch
if (require.main === module) {
    const prisma = new client_1.PrismaClient();
    const { app } = createApp(prisma);
    const PORT = process.env.PORT || 8001;
    const server = app.listen(PORT, () => {
        console.log(`BankSphere Authentication Service running on port ${PORT}`);
    });
    const shutdown = async () => {
        console.log('Shutting down Authentication Service gracefully...');
        server.close(async () => {
            await prisma.$disconnect();
            console.log('Postgres Auth connections closed.');
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
