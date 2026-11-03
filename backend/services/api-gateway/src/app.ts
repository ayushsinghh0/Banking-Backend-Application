import 'dotenv/config';
import express, { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import Redis from 'ioredis';
import {
  assertJwtVerificationConfigured,
  assertNoPlaceholders,
  CircuitBreaker,
  CircuitBreakerOptions,
  connectRedis,
  correlationIdMiddleware,
  errorHandlerMiddleware,
  GcraLimiter,
  httpMetricsMiddleware,
  isAddressAllowed,
  logger,
  notFoundHandler,
  parseCidrs,
  parseTrustProxy,
  staffNetworkError,
  startHttpServer,
  traceContextMiddleware,
} from '@banksphere/common';
import { createProxy, RouteTarget } from './proxy';
import { canonicalPath, classifyRequest } from './classify';
import { EdgeLimits, edgeLimitsFromEnv, GatewayRuntimeConfig, runtimeConfigFromEnv } from './config';
import { createEdgeRateLimiter, edgeIdentity, RateLimitChecker } from './rate-limit';
import { IpDenyList, ipRulesMiddleware, RedisIpRuleSource } from './ip-rules';
import { LoadShedder } from './load-shedding';

export type { RouteTarget };
export { canonicalPath };

export function defaultRoutes(env: NodeJS.ProcessEnv = process.env): RouteTarget[] {
  return [
    { name: 'auth-service', prefix: '/api/v1/auth', target: env.AUTH_SERVICE_URL || 'http://localhost:8001' },
    { name: 'customer-service', prefix: '/api/v1/customers', target: env.CUSTOMER_SERVICE_URL || 'http://localhost:8002' },
    { name: 'account-service', prefix: '/api/v1/accounts', target: env.ACCOUNT_SERVICE_URL || 'http://localhost:8003' },
    { name: 'transaction-service', prefix: '/api/v1/transactions', target: env.TRANSACTION_SERVICE_URL || 'http://localhost:8004' },
    { name: 'notification-service', prefix: '/api/v1/notifications', target: env.NOTIFICATION_SERVICE_URL || 'http://localhost:8005' },
    { name: 'fraud-service', prefix: '/api/v1/fraud', target: env.FRAUD_SERVICE_URL || 'http://localhost:8006' },
    { name: 'payment-service', prefix: '/api/v1/payments', target: env.PAYMENT_SERVICE_URL || 'http://localhost:8007' },
    { name: 'assistant-service', prefix: '/api/v1/assistant', target: env.ASSISTANT_SERVICE_URL || 'http://localhost:8008' },
    { name: 'realtime-service', prefix: '/api/v1/realtime', target: env.REALTIME_SERVICE_URL || 'http://localhost:8009' },
  ];
}

/**
 * Path prefixes that only staff use; restricted by STAFF_ALLOWED_CIDRS when it is configured. Defence in
 * depth only: staff actions on shared prefixes (/customers/:id, /accounts/:id/status, ...) are enforced by
 * role in every service (createAuthenticate), which is the real control.
 */
const STAFF_PATHS = [
  '/api/v1/auth/admin',
  '/api/v1/payments/admin',
  '/api/v1/fraud',
  '/api/v1/notifications',
  '/api/v1/transactions/deposit',
  '/api/v1/transactions/withdraw',
  '/api/v1/transactions/teller',
  '/api/v1/transactions/cash-operations',
  '/api/v1/accounts/lookup',
];

/** Staff-only endpoints whose path is also a prefix of customer routes (e.g. /customers vs /customers/me): exact only */
const STAFF_EXACT_PATHS = ['/api/v1/customers'];

const isStaffPath = (path: string) =>
  STAFF_EXACT_PATHS.includes(path) || STAFF_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/** Upstreams whose failure makes the API unusable; the others degrade gracefully instead */
const CRITICAL_UPSTREAMS = new Set(['auth-service', 'customer-service', 'account-service', 'transaction-service']);

/** Design section 10: 10 s window, opens at >= 50 % failures over >= 20 calls, 5 s cooldown, 3 probes */
const BREAKER_DEFAULTS = { windowMs: 10_000, minimumRequests: 20, failureRatio: 0.5, cooldownMs: 5_000, halfOpenProbes: 3 };

export interface GatewayOptions {
  routes?: RouteTarget[];
  /** Edge Redis (GCRA buckets, bans, IP rules mirror); without it (unit tests) there is no rate limiting */
  redis?: Redis;
  /** Rate-limit implementation; defaults to GcraLimiter over `redis` */
  limiter?: RateLimitChecker;
  limits?: EdgeLimits;
  /** IP deny rules (the caller starts and stops its refresh loop); defaults to one over `redis` */
  ipDenyList?: IpDenyList | null;
  corsOrigins?: string[];
  runtime?: Partial<GatewayRuntimeConfig>;
  breaker?: Partial<Omit<CircuitBreakerOptions, 'name'>>;
  /** Overrides TRUST_PROXY */
  trustProxy?: boolean | number | string;
}

export interface Gateway extends Express {
  locals: Express['locals'] & { breakers: Map<string, CircuitBreaker>; shedder: LoadShedder; ipDenyList: IpDenyList | null };
}

export function createGateway(options: GatewayOptions = {}): Gateway {
  const routes = options.routes ?? defaultRoutes();
  const runtime = { ...runtimeConfigFromEnv(), ...options.runtime };
  const app = express() as Gateway;
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when a load balancer that overwrites it sits in front (see README)
  const trustProxy = options.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }
  app.use(helmet());
  app.use(correlationIdMiddleware);
  app.use(traceContextMiddleware);
  app.use(httpMetricsMiddleware);

  const breakers = new Map(routes.map((r) => [r.name, new CircuitBreaker({ ...BREAKER_DEFAULTS, ...options.breaker, name: r.name })]));
  const shedder = new LoadShedder(runtime.maxInflight, runtime.maxStreams);
  const ipDenyList = options.ipDenyList !== undefined ? options.ipDenyList : options.redis ? new IpDenyList(new RedisIpRuleSource(options.redis)) : null;
  const limiter = options.limiter ?? (options.redis ? new GcraLimiter(options.redis) : null);
  app.locals.breakers = breakers;
  app.locals.shedder = shedder;
  app.locals.ipDenyList = ipDenyList;

  // Liveness: the gateway process itself (used by the container healthcheck / load balancer liveness)
  app.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'UP', service: 'api-gateway' });
  });

  // Readiness: only the services the core banking API cannot work without. Cached for a few seconds so
  // anonymous health probes can't be amplified into upstream load; reveals UP/DEGRADED and breaker states.
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
    res.status(cached.down.length ? 503 : 200).json({
      status: cached.down.length ? 'DEGRADED' : 'UP',
      service: 'api-gateway',
      breakers: Object.fromEntries([...breakers].map(([name, breaker]) => [name, breaker.state])),
    });
  });

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
      // X-Session-Transport: cookie opts a browser into the HttpOnly refresh-token cookie (auth-service);
      // Last-Event-ID resumes a real-time stream
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id', 'X-Session-Transport', 'Last-Event-ID'],
      exposedHeaders: ['X-Correlation-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    })
  );

  // Every rule below compares the canonical path; malformed paths stop here
  app.use(classifyRequest);
  app.use(shedder.middleware());
  if (ipDenyList) app.use(ipRulesMiddleware(ipDenyList));
  if (limiter) {
    app.use('/api', edgeIdentity(), createEdgeRateLimiter(limiter, options.limits ?? edgeLimitsFromEnv()));
  }

  // Staff-only APIs can be restricted to internal networks (VPN/ZTNA) with STAFF_ALLOWED_CIDRS
  const staffNetworks = parseCidrs(process.env.STAFF_ALLOWED_CIDRS);
  if (staffNetworks) {
    app.use((req: Request, res: Response, next) => {
      // Upstream routers match case-insensitively and tolerate encodings, so compare the canonical form
      if (!isStaffPath(req.edge!.canonicalPath)) return next();
      if (isAddressAllowed(staffNetworks, req.ip)) return next();
      req.log.warn({ path: req.path }, 'Staff API called from a non-allowed network');
      const error = staffNetworkError();
      res.status(error.statusCode).json({ error: { code: error.errorCode, message: error.message, correlationId: req.correlationId } });
    });
  }

  const isStreaming = (req: Request) => Boolean(req.edge?.streaming);
  for (const route of routes) {
    app.use(
      createProxy(route, {
        timeoutMs: runtime.upstreamTimeoutMs,
        connectTimeoutMs: runtime.connectTimeoutMs,
        breaker: breakers.get(route.name),
        isStreaming,
      })
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  return app;
}

async function main(): Promise<void> {
  assertNoPlaceholders(['REDIS_URL', 'RATE_LIMIT_REDIS_URL', 'TRUST_PROXY', 'STAFF_ALLOWED_CIDRS', 'JWT_VERIFY_KEYS']);
  if (process.env.NODE_ENV === 'production') {
    // Both are deployment facts the gateway can't guess; a wrong guess breaks per-IP limits and lockouts
    // for everyone (all clients look like the load balancer) or opens the staff APIs to the internet.
    if (!process.env.TRUST_PROXY) {
      throw new Error('TRUST_PROXY must be set in production: the number of proxies in front of the gateway that overwrite X-Forwarded-For, or 0 for none');
    }
    if (!parseCidrs(process.env.STAFF_ALLOWED_CIDRS)) {
      throw new Error('STAFF_ALLOWED_CIDRS must be set in production (the VPN/office networks allowed to call staff APIs)');
    }
    // Per-user limits need the public keys; without them every user behind one NAT would share an IP bucket
    assertJwtVerificationConfigured();
  } else if (!process.env.JWT_VERIFY_KEYS) {
    logger.warn('JWT_VERIFY_KEYS is not set: requests are rate limited by client address only');
  }
  // Fail fast on a malformed limit or cap before opening any connection
  const limits = edgeLimitsFromEnv();
  const runtime = runtimeConfigFromEnv();

  const redis = await connectRedis(process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL);
  const ipDenyList = new IpDenyList(new RedisIpRuleSource(redis));
  const stopIpRules = ipDenyList.start(runtime.ipRulesRefreshMs);
  const app = createGateway({ redis, ipDenyList, limits, runtime });
  startHttpServer(app, process.env.PORT || 8000, 'api-gateway', [stopIpRules, () => redis.quit()]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'api-gateway failed to start');
    process.exit(1);
  });
}
