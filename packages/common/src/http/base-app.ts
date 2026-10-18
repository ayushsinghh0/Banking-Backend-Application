import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { correlationIdMiddleware } from '../middleware/correlation-id.middleware';
import { NotFoundError } from '../errors/app-error';

/**
 * Creates an Express app with the security baseline shared by every service:
 * hardened headers, no framework fingerprint, bounded JSON bodies, request tracing.
 */
export function createBaseApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(correlationIdMiddleware);
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
  defaults = { limit: 20, maxLimit: 100 }
): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? ''), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), defaults.maxLimit)
    : defaults.limit;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
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
