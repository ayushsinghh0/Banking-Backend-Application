import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../logger/logger';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      log: typeof logger;
    }
  }
}

export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const correlationId =
    (req.header('x-correlation-id') as string) || crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  // Attach a contextual child logger with correlation ID bound
  req.log = logger.child({ correlationId });

  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    req.log.info(
      {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      'HTTP Request completed'
    );
  });

  next();
}
