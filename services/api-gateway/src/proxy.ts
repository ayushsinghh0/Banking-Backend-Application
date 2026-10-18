import http from 'http';
import https from 'https';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { INTERNAL_TOKEN_HEADER, logger } from '@banksphere/common';

export interface RouteTarget {
  prefix: string;
  target: string;
  name: string;
}

// Hop-by-hop headers (RFC 7230 §6.1) are connection-specific and must not be forwarded
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Headers a client must never be able to inject into internal traffic
const STRIPPED_REQUEST_HEADERS = new Set([
  INTERNAL_TOKEN_HEADER,
  'x-user-id',
  'x-user-role',
  'x-user-email',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]);

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
};

/**
 * Minimal streaming reverse proxy for one upstream. Matches only `prefix` and `prefix/...` (so
 * `/internal/*` on upstreams is never reachable), forwards the original path and query unchanged,
 * strips hop-by-hop and spoofable headers, and sets X-Forwarded-For to the client IP as resolved here.
 */
export function createProxy(route: RouteTarget, timeoutMs = 15_000): RequestHandler {
  const target = new URL(route.target);
  const client = target.protocol === 'https:' ? https : http;
  const agent = agents[target.protocol as 'http:' | 'https:'];

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;
    if (path !== route.prefix && !path.startsWith(`${route.prefix}/`)) {
      next();
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || STRIPPED_REQUEST_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    headers.host = target.host;
    headers['x-forwarded-for'] = req.ip || '';
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-correlation-id'] = req.correlationId;

    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.originalUrl,
        headers,
        agent,
      },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name)) responseHeaders[name] = value;
        }
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
      }
    );

    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy(Object.assign(new Error(`Upstream ${route.name} timed out`), { code: 'ETIMEDOUT' }));
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({ err: err.message, upstream: route.name, correlationId: req.correlationId }, 'Upstream request failed');
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const timedOut = err.code === 'ETIMEDOUT';
      res.status(timedOut ? 504 : 502).json({
        error: {
          code: timedOut ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY',
          message: `${route.name} is unavailable`,
          correlationId: req.correlationId,
        },
      });
    });

    // Client went away: stop the upstream work too
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
  };
}
