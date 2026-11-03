import { Request, Response, NextFunction } from 'express';
import { clientIpKey } from '@banksphere/common';

/**
 * What the edge needs to know about a request before it decides anything: the canonical form of its path
 * (upstream routers match case-insensitively and decode escapes, so every path rule here must compare the
 * same form), its cost class for rate limiting, whether it is a long-lived stream, and the client key.
 */
export type RouteClass = 'money-write' | 'assistant' | 'webhook';

export interface EdgeRequestInfo {
  canonicalPath: string;
  routeClass: RouteClass | null;
  /** SSE and other long-lived responses: no idle timeout, own concurrency cap, never buffered */
  streaming: boolean;
  /** clientIpKey(req.ip): an IPv4 address or an IPv6 /64 */
  ipKey: string;
  /** Set when the bearer token's signature verifies; used ONLY to key per-user limits */
  userId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      edge?: EdgeRequestInfo;
    }
  }
}

/** Decoded, lower-cased, without duplicate or trailing slashes; null if it can't be decoded or has dot segments */
export function canonicalPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  // No API has "." or ".." segments; refusing them means no upstream that resolves them could ever see a
  // different path than the one every rule here was checked against
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return decoded.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/** Money movements: POST only, exact paths (canonical form) */
const MONEY_WRITES = new Set([
  '/api/v1/transactions/transfer',
  '/api/v1/transactions/withdrawal-codes',
  '/api/v1/transactions/beneficiaries',
  '/api/v1/payments/top-ups',
]);
const ASSISTANT_MESSAGES = /^\/api\/v1\/assistant\/conversations\/[^/]+\/messages$/;
const WEBHOOKS = /^\/api\/v1\/payments\/webhooks\/[^/]+$/;
const REALTIME_STREAM = '/api/v1/realtime/stream';

export function routeClassOf(method: string, path: string): RouteClass | null {
  if (WEBHOOKS.test(path)) return 'webhook';
  if (method !== 'POST') return null;
  if (MONEY_WRITES.has(path)) return 'money-write';
  if (ASSISTANT_MESSAGES.test(path)) return 'assistant';
  return null;
}

/** The two streaming routes of the platform: the real-time event stream and assistant replies */
export function isStreamingRequest(method: string, path: string): boolean {
  return (method === 'GET' && path === REALTIME_STREAM) || (method === 'POST' && ASSISTANT_MESSAGES.test(path));
}

/** Classifies every request; an undecodable or dot-segment path is refused here, before any other rule */
export function classifyRequest(req: Request, res: Response, next: NextFunction): void {
  const path = canonicalPath(req.path);
  if (path === null) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request path', correlationId: req.correlationId } });
    return;
  }
  req.edge = {
    canonicalPath: path,
    routeClass: routeClassOf(req.method, path),
    streaming: isStreamingRequest(req.method, path),
    ipKey: clientIpKey(req.ip),
    userId: null,
  };
  next();
}
