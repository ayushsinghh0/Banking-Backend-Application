import 'dotenv/config';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import Redis from 'ioredis';
import { createProxyMiddleware } from 'http-proxy-middleware';
import {
  correlationIdMiddleware,
  createRateLimiter,
  errorHandlerMiddleware,
  INTERNAL_TOKEN_HEADER,
  logger,
  notFoundHandler,
} from '@banksphere/common';

export interface RouteTarget {
  prefix: string;
  target: string;
  name: string;
}

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

// Headers a client must never be able to inject into internal traffic
const STRIPPED_REQUEST_HEADERS = [INTERNAL_TOKEN_HEADER, 'x-user-id', 'x-user-role', 'x-user-email'];

export interface GatewayOptions {
  routes?: RouteTarget[];
  redis?: Redis;
  corsOrigins?: string[];
}

export function createGateway(options: GatewayOptions = {}) {
  const routes = options.routes ?? defaultRoutes();
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
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

  for (const header of STRIPPED_REQUEST_HEADERS) {
    app.use((req, _res, next) => {
      delete req.headers[header];
      next();
    });
  }

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

  app.get('/health', async (_req: Request, res: Response) => {
    const results = await Promise.all(
      routes.map(async (route) => {
        try {
          const r = await fetch(`${route.target}/health`, { signal: AbortSignal.timeout(2000) });
          return [route.name, r.ok ? 'UP' : 'DOWN'] as const;
        } catch {
          return [route.name, 'DOWN'] as const;
        }
      })
    );
    const upstreams = Object.fromEntries(results);
    const allUp = results.every(([, s]) => s === 'UP');
    res.status(allUp ? 200 : 503).json({
      status: allUp ? 'UP' : 'DEGRADED',
      service: 'api-gateway',
      upstreams,
      timestamp: new Date().toISOString(),
    });
  });

  for (const route of routes) {
    const proxy = createProxyMiddleware<Request, Response>({
      target: route.target,
      changeOrigin: true,
      // Only exact prefix matches; /internal/* on upstreams is therefore unreachable from outside
      pathFilter: (path) => path === route.prefix || path.startsWith(`${route.prefix}/`),
      proxyTimeout: 15000,
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.setHeader('x-correlation-id', req.correlationId);
          proxyReq.setHeader('x-forwarded-for', req.ip || '');
        },
        error: (err, req, res) => {
          const correlationId = (req as Request).correlationId;
          logger.error({ err: err.message, upstream: route.name, correlationId }, 'Upstream request failed');
          const response = res as Response;
          if (!response.headersSent && typeof response.status === 'function') {
            response.status(502).json({
              error: { code: 'BAD_GATEWAY', message: `${route.name} is unavailable`, correlationId },
            });
          }
        },
      },
    }) as unknown as RequestHandler;
    app.use(proxy);
  }

  app.use(notFoundHandler);
  app.use((err: Error, req: Request, res: Response, next: NextFunction) =>
    errorHandlerMiddleware(err, req, res, next)
  );

  return app;
}

if (require.main === module) {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis error (rate limiting fails open)'));

  const app = createGateway({ redis });
  const PORT = process.env.PORT || 8000;
  const server = app.listen(PORT, () => {
    logger.info(`BankSphere API Gateway running on port ${PORT}`);
  });

  const shutdown = () => {
    logger.info('Shutting down API Gateway gracefully...');
    server.close(() => {
      redis.disconnect();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
