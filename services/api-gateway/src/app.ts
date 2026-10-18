import 'dotenv/config';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import Redis from 'ioredis';
import {
  connectRedis,
  correlationIdMiddleware,
  createRateLimiter,
  errorHandlerMiddleware,
  logger,
  notFoundHandler,
  parseTrustProxy,
  startHttpServer,
} from '@banksphere/common';
import { createProxy, RouteTarget } from './proxy';

export type { RouteTarget };

export function defaultRoutes(env: NodeJS.ProcessEnv = process.env): RouteTarget[] {
  return [
    { name: 'auth-service', prefix: '/api/v1/auth', target: env.AUTH_SERVICE_URL || 'http://localhost:8001' },
    { name: 'customer-service', prefix: '/api/v1/customers', target: env.CUSTOMER_SERVICE_URL || 'http://localhost:8002' },
    { name: 'account-service', prefix: '/api/v1/accounts', target: env.ACCOUNT_SERVICE_URL || 'http://localhost:8003' },
    { name: 'transaction-service', prefix: '/api/v1/transactions', target: env.TRANSACTION_SERVICE_URL || 'http://localhost:8004' },
    { name: 'notification-service', prefix: '/api/v1/notifications', target: env.NOTIFICATION_SERVICE_URL || 'http://localhost:8005' },
    { name: 'fraud-service', prefix: '/api/v1/fraud', target: env.FRAUD_SERVICE_URL || 'http://localhost:8006' },
  ];
}

export interface GatewayOptions {
  routes?: RouteTarget[];
  redis?: Redis;
  corsOrigins?: string[];
}

export function createGateway(options: GatewayOptions = {}) {
  const routes = options.routes ?? defaultRoutes();
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when a load balancer that overwrites it sits in front (see README)
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }
  app.use(helmet());
  app.use(correlationIdMiddleware);

  const corsOrigins =
    options.corsOrigins ??
    (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  app.use(
    cors({
      origin: corsOrigins.length ? corsOrigins : false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
      exposedHeaders: ['X-Correlation-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    })
  );

  if (options.redis) {
    app.use(
      '/api',
      createRateLimiter(options.redis, {
        windowMs: 60 * 1000,
        maxRequests: Number(process.env.GATEWAY_RATE_LIMIT_PER_MINUTE || 300),
        keyPrefix: 'rl:gateway:',
      })
    );
  }

  // Public health reveals only UP/DOWN; per-upstream detail goes to the logs, not to the internet
  app.get('/health', async (req: Request, res: Response) => {
    const results = await Promise.all(
      routes.map(async (route) => {
        try {
          const r = await fetch(`${route.target}/health`, { signal: AbortSignal.timeout(2000) });
          return [route.name, r.ok] as const;
        } catch {
          return [route.name, false] as const;
        }
      })
    );
    const down = results.filter(([, ok]) => !ok).map(([name]) => name);
    if (down.length) req.log.warn({ down }, 'Gateway health: upstreams down');
    res.status(down.length ? 503 : 200).json({ status: down.length ? 'DEGRADED' : 'UP', service: 'api-gateway' });
  });

  for (const route of routes) {
    app.use(createProxy(route));
  }

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return app;
}

async function main(): Promise<void> {
  const redis = await connectRedis(process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL);
  const app = createGateway({ redis });
  if (process.env.NODE_ENV === 'production' && !process.env.TRUST_PROXY) {
    logger.warn('TRUST_PROXY is not set: client IPs are taken from the TCP connection (correct only without a load balancer)');
  }
  startHttpServer(app, process.env.PORT || 8000, 'api-gateway', [() => redis.quit()]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'api-gateway failed to start');
    process.exit(1);
  });
}
