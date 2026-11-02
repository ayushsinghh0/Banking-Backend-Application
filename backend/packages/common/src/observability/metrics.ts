import http from 'http';
import { Request, Response, NextFunction } from 'express';
import client, { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { logger } from '../logger/logger';

/**
 * One Prometheus registry per process. Every series carries a `service` label (SERVICE_NAME, or the
 * SERVICE build argument the Dockerfile sets), so dashboards can aggregate across replicas and services.
 */
export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: process.env.SERVICE_NAME || process.env.SERVICE || 'unknown' });
client.collectDefaultMetrics({ register: metricsRegistry });

/** Latency buckets for request/response work, from sub-millisecond cache hits to slow upstream calls */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Metrics are created through these helpers so a module loaded twice (tests, two routers sharing a helper)
// reuses the registered series instead of throwing "metric already registered".
export function counter<L extends string = string>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
  return (
    (metricsRegistry.getSingleMetric(name) as Counter<L> | undefined) ??
    new Counter<L>({ name, help, labelNames: [...labelNames], registers: [metricsRegistry] })
  );
}

export function gauge<L extends string = string>(name: string, help: string, labelNames: readonly L[] = []): Gauge<L> {
  return (
    (metricsRegistry.getSingleMetric(name) as Gauge<L> | undefined) ??
    new Gauge<L>({ name, help, labelNames: [...labelNames], registers: [metricsRegistry] })
  );
}

export function histogram<L extends string = string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
  buckets: number[] = LATENCY_BUCKETS
): Histogram<L> {
  return (
    (metricsRegistry.getSingleMetric(name) as Histogram<L> | undefined) ??
    new Histogram<L>({ name, help, labelNames: [...labelNames], buckets, registers: [metricsRegistry] })
  );
}

const requestDuration = histogram('http_server_requests_seconds', 'HTTP request duration by route template', [
  'method',
  'route',
  'status',
]);
const inflightRequests = gauge('http_server_inflight_requests', 'HTTP requests currently being handled');

/**
 * The Express route template that handled the request ("/api/v1/accounts/:accountId"), never the raw path:
 * raw paths carry ids and attacker-chosen strings, which would explode the number of series.
 *
 * Express restores req.baseUrl when a request leaves a router through next(err), so by the time the
 * response finishes the mount path may be gone. Routers here are mounted on parameter-free prefixes and
 * every route parameter matches exactly one segment, so the mount path is recovered as the leading
 * segments of the request path that the route template does not account for.
 */
export function routeLabel(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return 'unmatched';
  const template = routePath === '/' ? '' : routePath;
  let base = req.baseUrl;
  if (!base) {
    const requestSegments = (req.originalUrl || req.url).split('?')[0].split('/').filter(Boolean);
    const templateSegments = template.split('/').filter(Boolean);
    const baseCount = requestSegments.length - templateSegments.length;
    base = baseCount > 0 ? `/${requestSegments.slice(0, baseCount).join('/')}` : '';
  }
  return `${base}${template}` || '/';
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  inflightRequests.inc();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    inflightRequests.dec();
    // A client that disconnects before the response is sent has no real status: report it as 499 (nginx's convention)
    const status = res.writableFinished ? String(res.statusCode) : '499';
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    requestDuration.observe({ method: req.method, route: routeLabel(req), status }, seconds);
  };
  res.on('finish', record);
  res.on('close', record);
  next();
}

/**
 * Serves GET /metrics on its own port (METRICS_PORT, normally 9464). It is a separate listener so the API
 * gateway, which only proxies the public route prefixes, can never expose it; Prometheus scrapes it over
 * the internal network. Returns null when METRICS_PORT is unset.
 */
export function startMetricsServer(port: number | undefined = parsePort(process.env.METRICS_PORT)): http.Server | null {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': metricsRegistry.contentType, 'Cache-Control': 'no-store' });
        res.end(body);
      })
      .catch((err) => {
        logger.error({ err }, 'Collecting metrics failed');
        res.writeHead(500).end();
      });
  });
  server.on('error', (err) => logger.error({ err, port }, 'Metrics listener failed'));
  server.listen(port, () => logger.info({ port }, 'Metrics listening'));
  return server;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid METRICS_PORT=${JSON.stringify(value)}`);
  }
  return port;
}
