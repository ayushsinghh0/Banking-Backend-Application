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
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
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
