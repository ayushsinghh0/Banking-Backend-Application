import express, { Request, Response } from 'express';
import { PrismaClient } from './generated/client';
import {
  correlationIdMiddleware,
  errorHandlerMiddleware,
  setupSwagger,
} from '@banksphere/common';
import { TokenService } from './services/token.service';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { createAuthRouter } from './routes/auth.routes';

export function createApp(prisma: PrismaClient) {
  const app = express();
  app.use(express.json());

  // Tracing & Contextual Logger
  app.use(correlationIdMiddleware);

  // Service dependencies
  const tokenService = new TokenService();
  const authService = new AuthService(prisma, tokenService);
  const authController = new AuthController(authService);

  // Mount API Routes
  app.use('/api/v1/auth', createAuthRouter(authController));

  // OpenAPI Swagger Documentation
  setupSwagger(app, {
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
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'UP',
        service: 'auth-service',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({
        status: 'DOWN',
        database: err.message,
      });
    }
  });

  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
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
