import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { RateLimitExceededError, ServiceUnavailableError } from '../errors/app-error';

export interface RateLimiterOptions {
  windowMs: number; // e.g. 60000 for 1 minute
  maxRequests: number; // e.g. 100 requests per window
  keyPrefix?: string;
  skipFailedRequests?: boolean;
  /** When Redis is unavailable: true lets traffic through, false rejects with 503 (use for credential endpoints) */
  failOpen?: boolean;
  /** Custom bucket key; defaults to authenticated user id, then client IP */
  keyGenerator?: (req: Request) => string;
}

export function createRateLimiter(redis: Redis, options: RateLimiterOptions) {
  const { windowMs, maxRequests, keyPrefix = 'rl:', failOpen = true, keyGenerator } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Determine client identifier: authenticated user ID or client IP
    const identifier =
      keyGenerator?.(req) || req.user?.id || req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${keyPrefix}${identifier}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      // Redis pipeline for atomic sliding-window log
      const multi = redis.multi();
      multi.zremrangebyscore(key, 0, windowStart); // Remove requests outside the current window
      multi.zadd(key, now, `${now}-${Math.random()}`); // Add current request
      multi.zcard(key); // Count requests in window
      multi.pexpire(key, windowMs); // Set expiration

      const results = await multi.exec();
      if (!results) {
        next();
        return;
      }

      // The count is the 3rd operation (index 2)
      const count = (results[2][1] as number) || 0;
      const remaining = Math.max(0, maxRequests - count);

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

      if (count > maxRequests) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
        throw new RateLimitExceededError(
          `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowMs / 1000}s allowed.`
        );
      }

      next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        next(error);
        return;
      }
      if (req.log) {
        req.log.warn({ err: error }, `Rate limiter Redis failure, failing ${failOpen ? 'open' : 'closed'}`);
      }
      if (failOpen) {
        next();
      } else {
        next(new ServiceUnavailableError('Temporarily unavailable, please retry shortly'));
      }
    }
  };
}
