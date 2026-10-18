import 'dotenv/config';
import net from 'net';
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

/** Path prefixes that only staff use; restricted by STAFF_ALLOWED_CIDRS when it is configured */
const STAFF_PATHS = [
  '/api/v1/auth/admin',
  '/api/v1/fraud',
  '/api/v1/notifications',
  '/api/v1/transactions/deposit',
  '/api/v1/transactions/withdraw',
  '/api/v1/transactions/teller',
  '/api/v1/transactions/cash-operations',
];

/** Decoded, lower-cased, without duplicate or trailing slashes; null if it can't be decoded */
export function canonicalPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);
    return decoded.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/** "10.0.0.0/8,192.168.1.0/24,fd00::/8" -> BlockList, or null when unset */
export function parseCidrs(value: string | undefined): net.BlockList | null {
  if (!value || !value.trim()) return null;
  const list = new net.BlockList();
  for (const entry of value.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** Upstreams whose failure makes the API unusable; notification/fraud degrade gracefully instead */
const CRITICAL_UPSTREAMS = new Set(['auth-service', 'customer-service', 'account-service', 'transaction-service']);

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

  // Liveness: the gateway process itself (used by the container healthcheck / load balancer liveness)
  app.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'UP', service: 'api-gateway' });
  });

  // Readiness: only the services the core banking API cannot work without. Cached for a few seconds so
  // anonymous health probes can't be amplified into upstream load; reveals only UP/DEGRADED.
  const critical = routes.filter((r) => CRITICAL_UPSTREAMS.has(r.name));
  let cached: { at: number; down: string[] } | null = null;
  app.get('/health', async (req: Request, res: Response) => {
    if (!cached || Date.now() - cached.at > 5_000) {
      const results = await Promise.all(
        critical.map(async (route) => {
          try {
            const r = await fetch(`${route.target}/health`, { signal: AbortSignal.timeout(2000) });
            return [route.name, r.ok] as const;
          } catch {
            return [route.name, false] as const;
          }
        })
      );
      cached = { at: Date.now(), down: results.filter(([, ok]) => !ok).map(([name]) => name) };
      if (cached.down.length) req.log.warn({ down: cached.down }, 'Gateway readiness: critical upstreams down');
    }
    res.status(cached.down.length ? 503 : 200).json({ status: cached.down.length ? 'DEGRADED' : 'UP', service: 'api-gateway' });
  });

  // Staff-only APIs can be restricted to internal networks (VPN/ZTNA) with STAFF_ALLOWED_CIDRS
  const staffNetworks = parseCidrs(process.env.STAFF_ALLOWED_CIDRS);
  if (staffNetworks) {
    app.use((req: Request, res: Response, next) => {
      // Upstream routers match case-insensitively and tolerate encodings, so compare a canonical form
      const path = canonicalPath(req.path);
      if (path === null) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request path', correlationId: req.correlationId } });
        return;
      }
      if (!STAFF_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return next();
      const ip = (req.ip || '').replace(/^::ffff:/, '');
      const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
      if (ip && staffNetworks.check(ip, family)) return next();
      req.log.warn({ path: req.path }, 'Staff API called from a non-allowed network');
      res.status(403).json({ error: { code: 'NETWORK_NOT_ALLOWED', message: 'This endpoint is only available from the staff network', correlationId: req.correlationId } });
    });
  }

  for (const route of routes) {
    app.use(createProxy(route));
  }

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return app;
}

async function main(): Promise<void> {
  const redis = await connectRedis(process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL);
  if (process.env.NODE_ENV === 'production') {
    // Both are deployment facts the gateway can't guess; a wrong guess breaks per-IP limits and lockouts
    // for everyone (all clients look like the load balancer) or opens the staff APIs to the internet.
    if (!process.env.TRUST_PROXY) {
      throw new Error('TRUST_PROXY must be set in production: the number of proxies in front of the gateway that overwrite X-Forwarded-For, or 0 for none');
    }
    if (!parseCidrs(process.env.STAFF_ALLOWED_CIDRS)) {
      throw new Error('STAFF_ALLOWED_CIDRS must be set in production (the VPN/office networks allowed to call staff APIs)');
    }
  }
  const app = createGateway({ redis });
  startHttpServer(app, process.env.PORT || 8000, 'api-gateway', [() => redis.quit()]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'api-gateway failed to start');
    process.exit(1);
  });
}
