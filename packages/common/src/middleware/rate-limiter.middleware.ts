import net from 'net';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { RateLimitExceededError, ServiceUnavailableError } from '../errors/app-error';

export interface RateLimiterOptions {
  windowMs: number; // e.g. 60000 for 1 minute
  maxRequests: number; // e.g. 100 requests per window
  keyPrefix?: string;
  /** When Redis is unavailable: true lets traffic through, false rejects with 503 (use for credential endpoints) */
  failOpen?: boolean;
  /** Custom bucket key; defaults to authenticated user id, then client IP */
  keyGenerator?: (req: Request) => string;
}

/**
 * Normalises a client address for rate limiting. IPv6 clients usually control a whole /64, so
 * keying on the full address would let an attacker rotate through 2^64 fresh buckets.
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(mapped)) return mapped;
  if (!net.isIPv6(mapped)) return 'unknown';
  // Expand "::" and keep the first four hextets (the /64 network prefix)
  const [head, tail = ''] = mapped.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = mapped.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const full = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Fixed-window counter: one INCR per request on a key that expires with the window. Memory per client
 * is constant (a single integer), so floods cannot grow Redis; rejected requests cost nothing extra.
 */
export function createRateLimiter(redis: Redis, options: RateLimiterOptions) {
  const { windowMs, maxRequests, keyPrefix = 'rl:', failOpen = true, keyGenerator } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = keyGenerator?.(req) || req.user?.id || clientIpKey(req.ip || req.socket.remoteAddress);
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${keyPrefix}${identifier}:${windowStart}`;

    try {
      const results = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const resetSeconds = Math.ceil((windowStart + windowMs) / 1000);

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
      res.setHeader('X-RateLimit-Reset', resetSeconds);

      if (count > maxRequests) {
        res.setHeader('Retry-After', Math.max(1, resetSeconds - Math.floor(now / 1000)));
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
