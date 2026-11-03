import { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis from 'ioredis';
import { HttpError, RateLimitExceededError } from '../errors/app-error';
import { logger } from '../logger/logger';
import { counter } from '../observability/metrics';

/**
 * Generic Cell Rate Algorithm (the leaky bucket as a virtual scheduler, as in redis-cell and Stripe's limiter).
 * Each key stores one number, its "theoretical arrival time" (TAT), so memory per client is constant and a
 * flood of rejected requests writes nothing. Requests are spread evenly at `limit` per `periodMs` with up to
 * `burst` allowed at once, and the exact time until the next allowed request is known (Retry-After).
 *
 * The script optionally checks a ban key first (IP bans written by auth-service or the gateway), so the
 * edge pays a single Redis round trip per request for both. Redis server time is used, so replicas with
 * skewed clocks share one consistent schedule.
 *
 * Returns { allowed: 1|0|-1 (banned), remaining, retryAfterMs, resetAfterMs }.
 */
const GCRA_SCRIPT = `
if ARGV[5] == '1' then
  local banTtl = redis.call('PTTL', KEYS[2])
  if banTtl == -1 or banTtl > 0 then return {-1, 0, banTtl, 0} end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local tolerance = interval * tonumber(ARGV[2])
local increment = interval * tonumber(ARGV[3])
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local newTat = tat + increment
local allowAt = newTat - tolerance
if now < allowAt then
  local retryAfter = allowAt - now
  if increment > tolerance then retryAfter = -1 end
  return {0, 0, retryAfter, tat - now}
end
redis.call('SET', KEYS[1], string.format('%.3f', newTat), 'PX', math.max(1, math.ceil(newTat - now)))
return {1, math.floor((now - allowAt) / interval), 0, newTat - now}
`;

export interface GcraRule {
  /** Name used in keys and metrics, e.g. "user" or "money-write" */
  name: string;
  /** Sustained requests per period */
  limit: number;
  periodMs: number;
  /** Requests allowed at once on top of the sustained rate */
  burst: number;
}

export interface GcraResult {
  allowed: boolean;
  banned: boolean;
  /** Requests that could be made right now */
  remaining: number;
  /** When limited: ms until a request of this cost is allowed (-1: never, cost exceeds the burst); when banned: ms left on the ban (-1: no expiry) */
  retryAfterMs: number;
  /** ms until the bucket is completely full again */
  resetAfterMs: number;
}

type GcraRedis = Redis & {
  banksphereGcra(bucket: string, ban: string, interval: number, burst: number, cost: number, ttl: number, checkBan: string): Promise<number[]>;
};

const defined = new WeakSet<Redis>();
const limited = counter('gateway_rate_limited_total', 'Requests refused by a rate limit', ['route_class', 'scope']);

export class GcraLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'rl:gcra:'
  ) {
    if (!defined.has(redis)) {
      // EVALSHA with an automatic EVAL fallback: the script body crosses the network once per connection
      redis.defineCommand('banksphereGcra', { numberOfKeys: 2, lua: GCRA_SCRIPT });
      defined.add(redis);
    }
  }

  public async check(rule: GcraRule, key: string, options: { cost?: number; banKey?: string } = {}): Promise<GcraResult> {
    if (rule.limit <= 0 || rule.periodMs <= 0 || rule.burst < 1) throw new Error(`Invalid rate limit rule '${rule.name}'`);
    const interval = rule.periodMs / rule.limit;
    const cost = options.cost ?? 1;
    const bucket = `${this.keyPrefix}${rule.name}:${key}`;
    const [allowed, remaining, retryAfterMs, resetAfterMs] = await (this.redis as GcraRedis).banksphereGcra(
      bucket,
      options.banKey ?? bucket,
      interval,
      rule.burst,
      cost,
      0,
      options.banKey ? '1' : '0'
    );
    return {
      allowed: allowed === 1,
      banned: allowed === -1,
      remaining: Math.max(0, Number(remaining)),
      retryAfterMs: Number(retryAfterMs),
      resetAfterMs: Math.max(0, Number(resetAfterMs)),
    };
  }
}

export interface GcraMiddlewareOptions {
  rule: GcraRule;
  /** Bucket key for the request; null skips this limit (e.g. a per-user rule on an anonymous request) */
  key: (req: Request) => string | null;
  /** Ban key to check first (normally the client's IP ban) */
  banKey?: (req: Request) => string | null;
  cost?: (req: Request) => number;
  /** Metric label: which limit refused the request */
  scope?: string;
  /** true (default): let traffic through when Redis is down; false: refuse with 503 */
  failOpen?: boolean;
  keyPrefix?: string;
}

/**
 * Express middleware around GcraLimiter. Sets X-RateLimit-* headers (the names the web app and the gateway's
 * CORS policy already use) and Retry-After on refusals.
 */
export function createGcraMiddleware(redis: Redis, options: GcraMiddlewareOptions): RequestHandler {
  const limiter = new GcraLimiter(redis, options.keyPrefix);
  const failOpen = options.failOpen ?? true;
  const scope = options.scope ?? options.rule.name;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = options.key(req);
    if (key === null) return next();
    let result: GcraResult;
    try {
      result = await limiter.check(options.rule, key, {
        cost: options.cost?.(req),
        banKey: options.banKey?.(req) ?? undefined,
      });
    } catch (err) {
      (req.log ?? logger).warn({ err: (err as Error).message, rule: options.rule.name }, `Rate limiter unavailable, failing ${failOpen ? 'open' : 'closed'}`);
      if (failOpen) return next();
      return next(new HttpError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unavailable, please retry shortly'));
    }

    if (result.banned) {
      limited.inc({ route_class: options.rule.name, scope: 'ban' });
      if (result.retryAfterMs > 0) res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
      return next(new HttpError(403, 'IP_BLOCKED', 'Access from your network is temporarily blocked'));
    }

    res.setHeader('X-RateLimit-Limit', options.rule.burst);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAfterMs / 1000));
    if (!result.allowed) {
      limited.inc({ route_class: options.rule.name, scope });
      res.setHeader('Retry-After', Math.max(1, Math.ceil(Math.max(result.retryAfterMs, 0) / 1000)));
      return next(new RateLimitExceededError('Too many requests. Please slow down and try again shortly.'));
    }
    next();
  };
}

/** "600/min", "20/s", "300/h" -> { limit, periodMs } (env-configurable limits read the same everywhere) */
export function parseRate(value: string): { limit: number; periodMs: number } {
  const match = /^\s*(\d{1,7})\s*\/\s*(s|sec|second|m|min|minute|h|hour)\s*$/i.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid rate '${value}': expected e.g. "600/min"`);
  const unit = match[2].toLowerCase();
  const periodMs = unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : 3_600_000;
  return { limit: Number(match[1]), periodMs };
}
