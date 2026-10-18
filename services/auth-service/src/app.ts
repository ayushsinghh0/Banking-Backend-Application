import 'dotenv/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { PrismaClient } from '../generated/client';
import {
  connectRedis,
  createAuthenticate,
  createBaseApp,
  createEventPublisher,
  createMailerFromEnv,
  createRateLimiter,
  errorHandlerMiddleware,
  getJwtAccessSecret,
  isSwaggerEnabled,
  logger,
  Mailer,
  notFoundHandler,
  OutboxRelay,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
} from '@banksphere/common';
import { TokenService } from './services/token.service';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { createAuthRouter, AuthRateLimiters } from './routes/auth.routes';
import { AuthSecurityStore, RedisAuthSecurityStore } from './services/auth-security.store';

export interface AuthAppDeps {
  tokenState: TokenStateStore;
  security: AuthSecurityStore;
  mailer: Mailer;
  /** Enables Redis-backed per-IP rate limits (omitted in unit tests) */
  redis?: Redis;
}

export function createApp(prisma: PrismaClient, deps: AuthAppDeps) {
  getJwtAccessSecret(); // Fail fast on a missing/weak signing secret
  const app = createBaseApp();

  const tokenService = new TokenService();
  const authService = new AuthService({
    prisma,
    tokenService,
    tokenState: deps.tokenState,
    security: deps.security,
    mailer: deps.mailer,
  });
  const authController = new AuthController(authService);
  const authenticate = createAuthenticate(deps.tokenState);

  // Per-IP brute-force protection. Fails closed: if Redis is down these endpoints return 503.
  const ipLimiter = (prefix: string, windowMs: number, maxRequests: number) =>
    createRateLimiter(deps.redis!, {
      windowMs,
      maxRequests,
      keyPrefix: `rl:auth:${prefix}:`,
      failOpen: false,
      keyGenerator: (req) => req.ip || 'unknown',
    });
  const limiters: AuthRateLimiters | undefined = deps.redis
    ? {
        credentials: ipLimiter('credentials', 15 * 60_000, Number(process.env.AUTH_RATE_LIMIT_MAX || 30)),
        refresh: ipLimiter('refresh', 60_000, 60),
        recovery: ipLimiter('recovery', 15 * 60_000, Number(process.env.AUTH_RECOVERY_RATE_LIMIT_MAX || 10)),
      }
    : undefined;

  app.use('/api/v1/auth', createAuthRouter(authController, authenticate, limiters));

  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Authentication Service',
      version: '2.0.0',
      description:
        'Registration with email verification, Argon2id passwords, JWT access tokens with Redis-backed revocation, rotating refresh tokens, password reset',
      paths: {
        '/api/v1/auth/register': { post: { summary: 'Register (always CUSTOMER). 202; a verification email is sent' } },
        '/api/v1/auth/email/verify': { post: { summary: 'Verify email with the token from the email' } },
        '/api/v1/auth/email/resend-verification': { post: { summary: 'Re-send the verification email (always 202)' } },
        '/api/v1/auth/login': { post: { summary: 'Authenticate (email must be verified)' } },
        '/api/v1/auth/refresh': { post: { summary: 'Rotate refresh token' } },
        '/api/v1/auth/logout': { post: { summary: 'Revoke refresh-token family and the presented access token' } },
        '/api/v1/auth/password/forgot': { post: { summary: 'Email a single-use reset link (always 202)' } },
        '/api/v1/auth/password/reset': { post: { summary: 'Set a new password with a reset token; signs out everywhere' } },
        '/api/v1/auth/password/change': { post: { summary: 'Change password (authenticated); returns new tokens' } },
        '/api/v1/auth/me': { get: { summary: 'Current authenticated user' } },
        '/api/v1/auth/admin/users': { post: { summary: 'BANK_ADMIN only: create a user with an explicit role' } },
        '/api/v1/auth/admin/users/{userId}/status': { patch: { summary: 'BANK_ADMIN only: enable or disable a user' } },
      },
    });
  }

  app.get('/health', async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (deps.redis) await deps.redis.ping();
      res.json({ status: 'UP', service: 'auth-service', timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'auth-service' });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return { app, prisma, authService };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const redis = await connectRedis();
  const mailer = createMailerFromEnv();
  const tokenState = new RedisTokenStateStore(redis);
  const { app, authService } = createApp(prisma, {
    tokenState,
    security: new RedisAuthSecurityStore(redis),
    mailer,
    redis,
  });

  const synced = await authService.syncTokenVersions();
  logger.info({ synced }, 'Token versions mirrored to Redis');

  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'auth-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(Number(process.env.OUTBOX_POLL_INTERVAL_MS || 2000));

  const housekeeping = setInterval(() => {
    authService.purgeExpiredTokens().catch((err) => logger.error({ err }, 'Token purge failed'));
  }, 60 * 60 * 1000);

  startHttpServer(app, process.env.PORT || 8001, 'auth-service', [
    () => clearInterval(housekeeping),
    () => relay?.stop(),
    () => authService.drainBackgroundTasks(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'auth-service failed to start');
    process.exit(1);
  });
}
