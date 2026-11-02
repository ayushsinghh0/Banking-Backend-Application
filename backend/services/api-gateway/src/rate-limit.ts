import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  AuthenticatedUser,
  GcraResult,
  GcraRule,
  HttpError,
  RateLimitExceededError,
  counter,
  logger,
  readBearerToken,
  verifyAccessToken,
} from '@banksphere/common';
import { EdgeLimits } from './config';

/** The GCRA check (GcraLimiter in production: one Lua call per tier, with the ban check folded into the first) */
export interface RateLimitChecker {
  check(rule: GcraRule, key: string, options?: { cost?: number; banKey?: string }): Promise<GcraResult>;
}

/**
 * Edge-Redis key contract, shared with auth-service:
 *   edge:ban:<clientIpKey>   any value, with a TTL (or none): the client is refused with 403 IP_BLOCKED
 */
export const banKeyFor = (ipKey: string) => `edge:ban:${ipKey}`;

const limited = counter('gateway_rate_limited_total', 'Requests refused by a rate limit', ['route_class', 'scope']);
const ipBlocked = counter('gateway_ip_blocked_total', 'Requests refused because the client address is blocked', ['reason']);
const limiterErrors = counter('gateway_rate_limiter_errors_total', 'Rate-limit checks skipped because the edge Redis failed');

/**
 * Edge identity: verifies the bearer token's signature only to key per-user limits. It authorizes nothing
 * (every service authenticates and authorizes each request itself) and it never rejects: a missing, invalid,
 * expired or revoked token just means the request is limited by client address.
 */
export function edgeIdentity(verify: (token: string) => AuthenticatedUser = verifyAccessToken): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (token && req.edge) {
      try {
        req.edge.userId = verify(token).id;
      } catch {
        req.edge.userId = null;
      }
    }
    next();
  };
}

interface Check {
  rule: GcraRule;
  key: string;
  banKey?: string;
}

/**
 * One middleware for every tier, so a request makes the fewest Redis round trips and gets one coherent
 * answer:
 *   webhooks       per IP (webhook tier) only: payment providers retry from a few addresses and must not
 *                  compete with browsers for the general tiers
 *   everything     per IP, with the ban check folded into the same Lua call
 *   signed-in      per user, on top
 *   money-write    per user (or IP), on top
 *   assistant      per user (or IP), on top
 * Tiers are checked in that order and stop at the first refusal, so a refused request costs nothing in the
 * later buckets. Redis errors fail open (the services keep their own controls, and auth-service fails
 * closed on credentials); a ban therefore only applies while the edge Redis is reachable.
 */
export function createEdgeRateLimiter(limiter: RateLimitChecker, limits: EdgeLimits): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const edge = req.edge;
    if (!edge) return next();
    const subject = edge.userId ? `user:${edge.userId}` : `ip:${edge.ipKey}`;
    const checks: Check[] = [];
    if (edge.routeClass === 'webhook') {
      checks.push({ rule: limits.webhook, key: edge.ipKey, banKey: banKeyFor(edge.ipKey) });
    } else {
      checks.push({ rule: limits.ip, key: edge.ipKey, banKey: banKeyFor(edge.ipKey) });
      if (edge.userId) checks.push({ rule: limits.user, key: edge.userId });
      if (edge.routeClass === 'money-write') checks.push({ rule: limits.moneyWrite, key: subject });
      if (edge.routeClass === 'assistant') checks.push({ rule: limits.assistant, key: subject });
    }

    let tightest: { rule: GcraRule; result: GcraResult } | null = null;
    for (const check of checks) {
      let result: GcraResult;
      try {
        result = await limiter.check(check.rule, check.key, check.banKey ? { banKey: check.banKey } : {});
      } catch (err) {
        limiterErrors.inc();
        (req.log ?? logger).warn({ err: (err as Error).message, tier: check.rule.name }, 'Edge rate limiter unavailable, failing open');
        break; // Redis is down: the remaining tiers would fail the same way
      }

      if (result.banned) {
        ipBlocked.inc({ reason: 'ban' });
        limited.inc({ route_class: edge.routeClass ?? 'general', scope: 'ban' });
        if (result.retryAfterMs > 0) res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
        return next(new HttpError(403, 'IP_BLOCKED', 'Access from your network is temporarily blocked'));
      }
      if (!result.allowed) {
        limited.inc({ route_class: edge.routeClass ?? 'general', scope: check.rule.name });
        setRateHeaders(res, check.rule, result);
        res.setHeader('Retry-After', Math.max(1, Math.ceil(Math.max(result.retryAfterMs, 0) / 1000)));
        return next(new RateLimitExceededError('Too many requests. Please slow down and try again shortly.'));
      }
      if (!tightest || result.remaining < tightest.result.remaining) tightest = { rule: check.rule, result };
    }
    if (tightest) setRateHeaders(res, tightest.rule, tightest.result);
    next();
  };
}

/** X-RateLimit-* of the tier closest to refusing (the names the web app and CORS policy already use) */
function setRateHeaders(res: Response, rule: GcraRule, result: GcraResult): void {
  res.setHeader('X-RateLimit-Limit', rule.burst);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAfterMs / 1000));
}
