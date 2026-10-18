import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';

export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const correlationId = req.correlationId || 'unknown-correlation-id';

  // Handled operational business errors
  if (err instanceof AppError) {
    if (req.log) {
      req.log.warn({ err, correlationId }, `Operational error: ${err.message}`);
    }
    res.status(err.statusCode).json({
      error: {
        code: err.errorCode,
        message: err.message,
        correlationId,
      },
    });
    return;
  }

  // Schema input validation errors (Zod)
  if (err instanceof ZodError) {
    if (req.log) {
      req.log.warn({ issues: err.issues, correlationId }, 'Request schema validation failed');
    }
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input parameters',
        details: err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
        correlationId,
      },
    });
    return;
  }

  // Syntax error from malformed JSON bodies
  if ('type' in err && (err as any).type === 'entity.parse.failed') {
    res.status(400).json({
      error: {
        code: 'MALFORMED_JSON',
        message: 'Request body contains invalid JSON',
        correlationId,
      },
    });
    return;
  }

  // Body-parser and other http-errors style failures carry a safe client status (e.g. 413)
  const status = (err as any).status ?? (err as any).statusCode;
  if ((err as any).expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      error: { code: 'BAD_REQUEST', message: err.message, correlationId },
    });
    return;
  }

  // Database contention: connection-pool exhaustion, lock timeouts, deadlocks, serialization failures.
  // The whole DB transaction (including any idempotency claim) was rolled back, so retrying is safe.
  if (isRetryableDatabaseError(err)) {
    if (req.log) {
      req.log.warn({ code: (err as any).code, correlationId }, 'Database busy, asking client to retry');
    }
    res.setHeader('Retry-After', '1');
    res.status(503).json({
      error: {
        code: 'SERVICE_BUSY',
        message: 'The service is busy processing other requests for this resource. Please retry shortly.',
        correlationId,
      },
    });
    return;
  }

  // A required dependency (Redis security state) is unreachable: fail closed with a retryable 503
  if (isDependencyUnavailableError(err)) {
    if (req.log) {
      req.log.error({ err: (err as Error).message, correlationId }, 'Dependency unavailable');
    }
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Please retry shortly.', correlationId },
    });
    return;
  }

  // A database CHECK constraint is the last line of defence (e.g. balance limits): a 422, not a crash
  if (/violates check constraint|23514/.test(String((err as any).message ?? '') + String((err as any).meta?.code ?? ''))) {
    res.status(422).json({
      error: { code: 'CONSTRAINT_VIOLATION', message: 'The request would violate a data integrity rule', correlationId },
    });
    return;
  }

  // Unique-constraint races that slipped past application-level checks
  if ((err as any).code === 'P2002') {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'Resource already exists', correlationId },
    });
    return;
  }

  // Unhandled / programmer errors
  if (req.log) {
    req.log.error({ err, correlationId }, 'Unhandled server exception');
  } else {
    console.error(`[Unhandled Error] [Correlation: ${correlationId}]`, err);
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred. Please contact support.',
      correlationId,
    },
  });
}

const RETRYABLE_PRISMA_CODES = new Set([
  'P2024', // timed out fetching a connection from the pool
  'P2028', // interactive transaction could not start in time / expired
  'P2034', // write conflict or deadlock, retry the transaction
]);
const RETRYABLE_PG_STATES = ['55P03', '40P01', '40001']; // lock_not_available, deadlock, serialization failure

export function isRetryableDatabaseError(err: unknown): boolean {
  const e = err as any;
  if (!e || typeof e !== 'object') return false;
  if (RETRYABLE_PRISMA_CODES.has(e.code)) return true;
  const pgCode = e.meta?.code ?? e.meta?.database_error_code;
  if (RETRYABLE_PG_STATES.includes(pgCode)) return true;
  const message = String(e.message ?? '');
  return /lock timeout|deadlock detected|could not serialize access/i.test(message);
}

/** ioredis errors raised while the connection is down (fail-fast clients: no offline queue) */
export function isDependencyUnavailableError(err: unknown): boolean {
  const e = err as any;
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'MaxRetriesPerRequestError') return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(e.code)) return true;
  return /Stream isn't writeable|Connection is closed|max retries per request|^LOADING /i.test(String(e.message ?? ''));
}
