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
  assertJwtSigningConfigured,
  clientIpKey,
  errorHandlerMiddleware,
  isSwaggerEnabled,
  logger,
  Mailer,
  notFoundHandler,
  OutboxRelay,
  RedisTokenStateStore,
  setupSwagger,
  startHttpServer,
  TokenStateStore,
  prismaClientOptions,
} from '@banksphere/common';
import { TokenService } from './services/token.service';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { AdminRequestService } from './services/admin-requests.service';
import { createAuthRouter, AuthRateLimiters } from './routes/auth.routes';
import { AuthSecurityStore, RedisAuthSecurityStore } from './services/auth-security.store';
import { assertMfaEncryptionConfigured } from './services/totp';

export interface AuthAppDeps {
  tokenState: TokenStateStore;
  security: AuthSecurityStore;
  mailer: Mailer;
  /** Security Redis (token state); used by /health */
  redis?: Redis;
  /** Evictable Redis for per-IP rate limits (omitted in unit tests) */
  rateLimitRedis?: Redis;
}

export function createApp(prisma: PrismaClient, deps: AuthAppDeps) {
  assertJwtSigningConfigured(); // Fail fast on a missing/mismatched signing key
  assertMfaEncryptionConfigured();
  const app = createBaseApp();

  const tokenService = new TokenService();
  const authService = new AuthService({
    prisma,
    tokenService,
    tokenState: deps.tokenState,
    security: deps.security,
    mailer: deps.mailer,
  });
  const authController = new AuthController(authService, new AdminRequestService(prisma, authService));
  const auth = {
    authenticate: createAuthenticate(deps.tokenState),
    authenticateForEnrolment: createAuthenticate(deps.tokenState, { allowStaffWithoutMfa: true }),
  };

  // Per-IP brute-force protection. Fails closed: if Redis is down these endpoints return 503.
  const ipLimiter = (prefix: string, windowMs: number, maxRequests: number) =>
    createRateLimiter(deps.rateLimitRedis!, {
      windowMs,
      maxRequests,
      keyPrefix: `rl:auth:${prefix}:`,
      failOpen: false,
      keyGenerator: (req) => clientIpKey(req.ip),
    });
  const limiters: AuthRateLimiters | undefined = deps.rateLimitRedis
    ? {
        credentials: ipLimiter('credentials', 15 * 60_000, Number(process.env.AUTH_RATE_LIMIT_MAX || 30)),
        refresh: ipLimiter('refresh', 60_000, 60),
        recovery: ipLimiter('recovery', 15 * 60_000, Number(process.env.AUTH_RECOVERY_RATE_LIMIT_MAX || 10)),
      }
    : undefined;

  app.use('/api/v1/auth', createAuthRouter(authController, auth, limiters));

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
        '/api/v1/auth/login': { post: { summary: 'Authenticate (email must be verified); returns tokens or an MFA challenge' } },
        '/api/v1/auth/login/mfa': { post: { summary: 'Complete login with {challengeToken, code}' } },
        '/api/v1/auth/mfa/setup': { post: { summary: 'Start TOTP enrolment (returns secret + otpauth URI)' } },
        '/api/v1/auth/mfa/enable': { post: { summary: 'Confirm TOTP enrolment with a code; returns an MFA session' } },
        '/api/v1/auth/mfa/disable': { post: { summary: 'Customers only: disable TOTP with password + code' } },
        '/api/v1/auth/admin/users/{userId}/mfa/reset': { post: { summary: 'BANK_ADMIN: reset another user\'s MFA' } },
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
  if (process.env.NODE_ENV === 'production' && !process.env.STAFF_EMAIL_DOMAIN) {
    throw new Error('STAFF_EMAIL_DOMAIN must be set in production: staff accounts must use the corporate mail domain');
  }
  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  const rateLimitRedis = await connectRedis(process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL);
  const mailer = createMailerFromEnv();
  const tokenState = new RedisTokenStateStore(redis);
  const { app, authService } = createApp(prisma, {
    tokenState,
    security: new RedisAuthSecurityStore(rateLimitRedis, redis),
    mailer,
    redis,
    rateLimitRedis,
  });

  const synced = await authService.syncTokenVersions();
  logger.info({ synced }, 'Token versions mirrored to Redis');
  // Repairs any token-version write that failed (e.g. Redis blip during a password reset) within 30s
  const versionSync = setInterval(() => {
    authService
      .syncTokenVersions(new Date(Date.now() - authService.syncLookbackMs()))
      .catch((err) => logger.warn({ err }, 'Periodic token version sync failed'));
  }, 30_000);

  const { publisher, kafka } = createEventPublisher(process.env.KAFKA_CLIENT_ID || 'auth-service');
  const relay = publisher ? new OutboxRelay(prisma, publisher) : null;
  relay?.start(Number(process.env.OUTBOX_POLL_INTERVAL_MS || 2000));

  const housekeeping = setInterval(() => {
    authService.purgeExpiredTokens().catch((err) => logger.error({ err }, 'Token purge failed'));
  }, 60 * 60 * 1000);

  startHttpServer(app, process.env.PORT || 8001, 'auth-service', [
    () => clearInterval(housekeeping),
    () => clearInterval(versionSync),
    () => relay?.stop(),
    () => authService.drainBackgroundTasks(),
    () => kafka?.disconnect(),
    () => prisma.$disconnect(),
    () => redis.quit(),
    () => rateLimitRedis.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'auth-service failed to start');
    process.exit(1);
  });
}
