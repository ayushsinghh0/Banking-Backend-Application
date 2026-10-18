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
