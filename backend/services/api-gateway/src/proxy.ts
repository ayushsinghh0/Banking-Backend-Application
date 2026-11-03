import http from 'http';
import https from 'https';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { CircuitBreaker, INTERNAL_TOKEN_HEADER, logger, outgoingTraceparent } from '@banksphere/common';

export interface RouteTarget {
  prefix: string;
  target: string;
  name: string;
}

export interface ProxyOptions {
  /** Idle timeout for ordinary requests (none for streams) */
  timeoutMs?: number;
  /** Streams: time allowed to open the upstream connection */
  connectTimeoutMs?: number;
  /** Refuses calls while the upstream is failing; null disables it */
  breaker?: CircuitBreaker | null;
  /** Long-lived responses (SSE): no idle timeout, a dedicated connection, flushed as they arrive */
  isStreaming?: (req: Request) => boolean;
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
  'traceparent', // replaced: the upstream's parent span is this hop
]);

/** Upstream answers that mean "the upstream is in trouble" for the circuit breaker */
const FAILURE_STATUSES = new Set([502, 503, 504]);

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
};
// Streams hold their connection for minutes: they get their own sockets (no pool limit, no reuse), so a few
// thousand open streams can never exhaust the pool that ordinary requests depend on
const streamAgents = {
  'http:': new http.Agent({ keepAlive: false, maxSockets: Infinity }),
  'https:': new https.Agent({ keepAlive: false, maxSockets: Infinity }),
};

/**
 * Labels the request for http_server_requests_seconds with the upstream prefix ("/api/v1/auth/*"): proxied
 * requests have no Express route, and the raw path (ids, attacker-chosen strings) must never become a label.
 */
function labelRoute(req: Request, prefix: string): void {
  req.baseUrl = prefix;
  (req as { route?: unknown }).route = { path: '/*' };
}

function errorBody(req: Request, code: string, message: string) {
  return { error: { code, message, correlationId: req.correlationId } };
}

/**
 * Minimal streaming reverse proxy for one upstream. Matches only `prefix` and `prefix/...` (so
 * `/internal/*` on upstreams is never reachable), forwards the original path and query unchanged,
 * strips hop-by-hop and spoofable headers, and sets X-Forwarded-For to the client IP as resolved here.
 *
 * Circuit breaker: a permit is taken before the request; connection errors, timeouts and 502/503/504 answers
 * count as failures, everything else (including 4xx/500 from a healthy service) as success. A stream counts
 * its initial response only. A client that leaves before the upstream answered is not the upstream's fault.
 */
export function createProxy(route: RouteTarget, options: ProxyOptions = {}): RequestHandler {
  const target = new URL(route.target);
  const client = target.protocol === 'https:' ? https : http;
  const protocol = target.protocol as 'http:' | 'https:';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const breaker = options.breaker ?? null;

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;
    if (path !== route.prefix && !path.startsWith(`${route.prefix}/`)) {
      next();
      return;
    }
    labelRoute(req, route.prefix);

    const permit = breaker ? breaker.acquire() : null;
    if (breaker && !permit) {
      res.setHeader('Retry-After', '5');
      res.status(503).json(errorBody(req, 'UPSTREAM_UNAVAILABLE', `${route.name} is temporarily unavailable, please retry shortly`));
      return;
    }
    let reported = false;
    const report = (success: boolean) => {
      if (reported) return;
      reported = true;
      permit?.(success);
    };

    const streaming = options.isStreaming?.(req) ?? false;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || STRIPPED_REQUEST_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    headers.host = target.host;
    headers['x-forwarded-for'] = req.ip || '';
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-correlation-id'] = req.correlationId;
    headers.traceparent = outgoingTraceparent(req);

    let clientGone = false;
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.originalUrl,
        headers,
        agent: streaming ? streamAgents[protocol] : agents[protocol],
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        report(!FAILURE_STATUSES.has(status));
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name)) responseHeaders[name] = value;
        }
        if (streaming) {
          // Tell any buffering proxy in front (nginx) to pass events straight through
          responseHeaders['x-accel-buffering'] = 'no';
          responseHeaders['cache-control'] ??= 'no-cache';
        }
        res.writeHead(status, responseHeaders);
        if (streaming) {
          res.flushHeaders();
          req.socket.setNoDelay(true);
        }
        // pipe() doesn't propagate a source failure: if the upstream dies mid-body the client would wait
        // forever. Headers are already sent, so the only honest signal left is to abort the client response.
        upstreamRes.on('error', (err) => {
          logger.warn({ err: err.message, upstream: route.name, correlationId: req.correlationId }, 'Upstream response aborted');
          res.destroy();
        });
        upstreamRes.on('close', () => {
          if (!upstreamRes.complete) res.destroy();
        });
        upstreamRes.pipe(res);
      }
    );

    if (streaming) {
      // No idle timeout (a stream may be quiet for minutes); only the connection must open in time
      upstream.on('socket', (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => {
          upstream.destroy(Object.assign(new Error(`Upstream ${route.name} connect timed out`), { code: 'ETIMEDOUT' }));
        }, connectTimeoutMs);
        socket.once('connect', () => clearTimeout(timer));
        upstream.once('close', () => clearTimeout(timer));
      });
    } else {
      upstream.setTimeout(timeoutMs, () => {
        upstream.destroy(Object.assign(new Error(`Upstream ${route.name} timed out`), { code: 'ETIMEDOUT' }));
      });
    }

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (clientGone) {
        report(true);
        return;
      }
      report(false);
      logger.error({ err: err.message, upstream: route.name, correlationId: req.correlationId }, 'Upstream request failed');
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const timedOut = err.code === 'ETIMEDOUT';
      res
        .status(timedOut ? 504 : 502)
        .json(errorBody(req, timedOut ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY', `${route.name} is unavailable`));
    });

    // Client went away: stop the upstream work too (for a stream, this is how the upstream learns it ended)
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        upstream.destroy();
      }
    });

    req.pipe(upstream);
  };
}
