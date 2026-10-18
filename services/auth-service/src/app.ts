import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  createBaseApp,
  createEventPublisher,
  createRateLimiter,
  errorHandlerMiddleware,
  EventPublisher,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  setupSwagger,
} from '@banksphere/common';
import { TokenService } from './services/token.service';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { createAuthRouter, AuthRateLimiters } from './routes/auth.routes';

export interface AuthAppOptions {
  eventPublisher?: EventPublisher | null;
  redis?: Redis;
}

export function createApp(prisma: PrismaClient, options: AuthAppOptions = {}) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  // Service dependencies
  const tokenService = new TokenService();
  const authService = new AuthService(prisma, tokenService, options.eventPublisher);
  const authController = new AuthController(authService);

  // Brute-force protection for credential and token endpoints (per client IP)
  const limiters: AuthRateLimiters | undefined = options.redis
    ? {
        credentials: createRateLimiter(options.redis, {
          windowMs: 15 * 60 * 1000,
          maxRequests: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
          keyPrefix: 'rl:auth:credentials:',
        }),
        refresh: createRateLimiter(options.redis, {
          windowMs: 60 * 1000,
          maxRequests: 30,
          keyPrefix: 'rl:auth:refresh:',
        }),
      }
    : undefined;

  // Mount API Routes
  app.use('/api/v1/auth', createAuthRouter(authController, limiters));

  // OpenAPI Swagger Documentation
  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Authentication Service',
      version: '1.0.0',
      description: 'User registration, Argon2id password verification, and JWT refresh token rotation',
      paths: {
        '/api/v1/auth/register': {
          post: {
            summary: 'Register a new customer (role is always CUSTOMER)',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string', minLength: 8, maxLength: 128 },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/v1/auth/login': {
          post: { summary: 'Authenticate credentials and obtain token pair' },
        },
        '/api/v1/auth/refresh': {
          post: { summary: 'Rotate refresh token and obtain fresh access token' },
        },
        '/api/v1/auth/logout': {
          post: { summary: 'Revoke active refresh token session' },
        },
        '/api/v1/auth/me': {
          get: { summary: 'Current authenticated user' },
        },
        '/api/v1/auth/admin/users': {
          post: { summary: 'BANK_ADMIN only: create a user with an explicit role' },
        },
        '/api/v1/auth/admin/users/{userId}/status': {
          patch: { summary: 'BANK_ADMIN only: enable or disable a user' },
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
        service: 'auth-service',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'auth-service' });
    }
  });

  app.use(notFoundHandler);
  // Centralized Error Handling
  app.use(errorHandlerMiddleware);

  return { app, prisma };
}

// Direct server launch
if (require.main === module) {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
  });
  redis.on('error', (err) => logger.warn({ err }, 'Redis error (rate limiting fails open)'));
  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'auth-service');
  const { app } = createApp(prisma, { eventPublisher: publisher, redis });
  const PORT = process.env.PORT || 8001;

  const server = app.listen(PORT, () => {
    logger.info(`BankSphere Authentication Service running on port ${PORT}`);
  });

  const shutdown = async () => {
    logger.info('Shutting down Authentication Service gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      await kafka?.disconnect().catch(() => {});
      redis.disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
