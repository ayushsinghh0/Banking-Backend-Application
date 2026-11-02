import http from 'http';
import { AddressInfo } from 'net';
import express, { Router } from 'express';
import request from 'supertest';
import {
  auditHash,
  canonicalJson,
  correlationIdMiddleware,
  errorHandlerMiddleware,
  EventStream,
  formatTraceparent,
  GENESIS_HASH,
  httpMetricsMiddleware,
  metricsRegistry,
  NotFoundError,
  openEventStream,
  outgoingTraceparent,
  parseTraceparent,
  routeLabel,
  startMetricsServer,
  traceContextMiddleware,
  verifyAuditChain,
} from '../src';

describe('openEventStream', () => {
  let server: http.Server;
  let stream: EventStream | null = null;
  let closedOnServer = false;

  beforeAll(async () => {
    const app = express();
    app.get('/stream', (req, res) => {
      stream = openEventStream(req, res, { heartbeatMs: 30, retryMs: 2_000 });
      stream.onClose(() => (closedOnServer = true));
      stream.send('ready', { connectionId: 'c1', amount: 5n }, '1');
    });
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
  });
  afterAll(() => server.close());

  it('streams typed JSON events with ids, heartbeats, and notices the client leaving', async () => {
    const controller = new AbortController();
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes(': keep-alive')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('retry: 2000\n\n');
    expect(text).toContain('id: 1\nevent: ready\ndata: {"connectionId":"c1","amount":"5"}\n\n');

    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(closedOnServer).toBe(true);
    expect(stream!.closed).toBe(true);
    expect(stream!.send('late', {})).toBe(false);
  });

  it('refuses event names and ids that could break the framing', () => {
    expect(() => stream!.send('bad\nevent', {})).toThrow();
  });
});

describe('audit chain', () => {
  const row = (id: string, prevHash: string, record: Record<string, unknown>) => ({ id, prevHash, hash: auditHash(prevHash, record), record });

  it('hashes canonical JSON, so key order and BigInt/Date representation never change a hash', () => {
    expect(canonicalJson({ b: 1n, a: new Date('2026-01-01T00:00:00Z'), c: undefined, d: [{ z: 1, y: 2 }] })).toBe(
      '{"a":"2026-01-01T00:00:00.000Z","b":"1","d":[{"y":2,"z":1}]}'
    );
    expect(auditHash(GENESIS_HASH, { x: 1, y: 2 })).toBe(auditHash(GENESIS_HASH, { y: 2, x: 1 }));
  });

  it('verifies an intact chain and finds the first edited, removed or reordered row', () => {
    const a = row('a', GENESIS_HASH, { action: 'APPROVE', amount: 100n });
    const b = row('b', a.hash, { action: 'REFUND', amount: 50n });
    const c = row('c', b.hash, { action: 'FREEZE' });
    expect(verifyAuditChain([a, b, c])).toEqual({ ok: true, checked: 3 });

    const edited = { ...b, record: { action: 'REFUND', amount: 5n } };
    expect(verifyAuditChain([a, edited, c])).toEqual({ ok: false, checked: 1, brokenAt: 'b', reason: 'content' });
    expect(verifyAuditChain([a, c])).toEqual({ ok: false, checked: 1, brokenAt: 'c', reason: 'link' });
    expect(verifyAuditChain([b, a, c])).toMatchObject({ ok: false, brokenAt: 'b' });
  });
});

describe('trace context', () => {
  it('accepts only well-formed, non-zero traceparent headers', () => {
    const valid = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceparent(valid)).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: '01' });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-xyz-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(formatTraceparent('a'.repeat(32), 'b'.repeat(16))).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(parseTraceparent(outgoingTraceparent(undefined))).not.toBeNull();
  });

  it('continues an incoming trace with a new span, or starts one', async () => {
    const app = express();
    app.use(correlationIdMiddleware, traceContextMiddleware);
    app.get('/', (req, res) => res.json(req.trace));
    const continued = await request(app).get('/').set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    expect(continued.body).toMatchObject({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7', flags: '00' });
    expect(continued.body.spanId).toMatch(/^[0-9a-f]{16}$/);
    const fresh = await request(app).get('/');
    expect(fresh.body.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('HTTP metrics', () => {
  const metricsApp = () => {
    const app = express();
    app.use(httpMetricsMiddleware, correlationIdMiddleware);
    const router = Router();
    router.get('/accounts/:accountId', (req, res) => res.json({ route: routeLabel(req) }));
    router.get('/accounts/:accountId/missing', (_req, _res, next) => next(new NotFoundError()));
    app.use('/api/v1/things', router);
    app.use(errorHandlerMiddleware);
    return app;
  };

  it('labels requests with the route template, including requests that left the router with an error', async () => {
    const app = metricsApp();
    const ok = await request(app).get('/api/v1/things/accounts/0b6c4f4e-1111-4b8a-9c3e-2b1f6f0f0a01').expect(200);
    expect(ok.body.route).toBe('/api/v1/things/accounts/:accountId');
    await request(app).get('/api/v1/things/accounts/abc/missing').expect(404);
    await request(app).get('/random/attacker/path').expect(404);

    const text = await metricsRegistry.metrics();
    expect(text).toContain('route="/api/v1/things/accounts/:accountId",status="200"');
    expect(text).toContain('route="/api/v1/things/accounts/:accountId/missing",status="404"');
    expect(text).toContain('route="unmatched",status="404"');
    expect(text).not.toContain('attacker');
  });

  it('serves the registry on its own port only', async () => {
    const server = startMetricsServer(0 as unknown as number);
    expect(server).toBeNull(); // 0/unset means disabled
    const live = startMetricsServer(39_464);
    await new Promise((r) => live!.once('listening', r));
    const metrics = await fetch('http://127.0.0.1:39464/metrics');
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('process_cpu_user_seconds_total');
    expect((await fetch('http://127.0.0.1:39464/other')).status).toBe(404);
    live!.close();
  });
});
