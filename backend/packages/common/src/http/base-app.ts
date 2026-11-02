import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { correlationIdMiddleware } from '../middleware/correlation-id.middleware';
import { NotFoundError } from '../errors/app-error';
import { httpMetricsMiddleware } from '../observability/metrics';
import { traceContextMiddleware } from '../observability/trace-context';

declare global {
  namespace Express {
    interface Request {
      /** The exact request bytes, kept only for paths that verify a signature over them (see keepRawBody) */
      rawBody?: Buffer;
    }
  }
}

export interface BaseAppOptions {
  /**
   * Requests whose raw body must be kept (as req.rawBody) next to the parsed JSON, e.g. webhooks whose
   * signature covers the exact bytes. Re-serialising the parsed body would not reproduce them.
   */
  keepRawBody?: (req: Request) => boolean;
}

/**
 * Creates an Express app with the security baseline shared by every service:
 * hardened headers, no framework fingerprint, bounded JSON bodies, request tracing and metrics.
 */
export function createBaseApp(options: BaseAppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }
  app.use(helmet());
  app.use(httpMetricsMiddleware);
  app.use(
    express.json({
      limit: '100kb',
      verify: options.keepRawBody
        ? (req, _res, buf) => {
            if (options.keepRawBody!(req as Request)) (req as Request).rawBody = Buffer.from(buf);
          }
        : undefined,
    })
  );
  app.use(correlationIdMiddleware);
  app.use(traceContextMiddleware);
  // Liveness: the process is serving requests. /health (per service) is readiness: its dependencies.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'UP' });
  });
  return app;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

export function isSwaggerEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true';
}

/**
 * Parses limit/offset query params into a safe, bounded window.
 */
export function parsePagination(
  query: Record<string, unknown>,
  defaults = { limit: 20, maxLimit: 100, maxOffset: 10_000 }
): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? ''), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), defaults.maxLimit)
    : defaults.limit;
  // Deep offsets force the database to scan and discard rows; cap them (use filters for older data)
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), defaults.maxOffset) : 0;
  return { limit, offset };
}

/**
 * TRUST_PROXY: a hop count ("1" = trust only the API gateway / load balancer directly in front),
 * "true"/"false", or a comma-separated list of trusted proxy addresses/subnets. A numeric string
 * must become a number: Express would otherwise treat "1" as an IP address.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
