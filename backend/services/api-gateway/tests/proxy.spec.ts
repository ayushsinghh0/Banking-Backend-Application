import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { metricsRegistry } from '@banksphere/common';
import { createGateway, Gateway, GatewayOptions } from '../src/app';

const listen = async (server: http.Server) => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readAll(res: Response): Promise<{ chunks: Array<{ at: number; text: string }>; error?: unknown }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: Array<{ at: number; text: string }> = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { chunks };
      chunks.push({ at: Date.now(), text: decoder.decode(value) });
    }
  } catch (error) {
    return { chunks, error };
  }
}

describe('circuit breaker through the proxy', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let mode: 'unavailable' | 'error' | 'ok' | 'hang' = 'ok';
  let hits = 0;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200).end('{}');
        return;
      }
      hits += 1;
      if (mode === 'hang') return; // never answers
      const status = mode === 'unavailable' ? 503 : mode === 'error' ? 500 : 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
    });
    upstream.listen(0);
    upstreamUrl = await listen(upstream);
  });
  afterAll(() => {
    upstream.closeAllConnections?.();
    upstream.close();
  });
  beforeEach(() => {
    hits = 0;
    mode = 'ok';
  });

  let clock = 0;
  const gateway = (target = upstreamUrl, extra: GatewayOptions = {}): Gateway =>
    createGateway({
      routes: [{ name: 'transaction-service', prefix: '/api/v1/transactions', target }],
      breaker: { minimumRequests: 4, failureRatio: 0.5, cooldownMs: 5_000, halfOpenProbes: 2, now: () => clock },
      ...extra,
    });
  const call = (app: Gateway) => request(app).get('/api/v1/transactions/accounts/a1/balance');

  it('opens after upstream 503s, then answers 503 UPSTREAM_UNAVAILABLE without calling the upstream; readiness shows it', async () => {
    const app = gateway();
    mode = 'unavailable';
    for (let i = 0; i < 4; i++) expect((await call(app)).status).toBe(503);
    expect(hits).toBe(4);

    const refused = await call(app);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(refused.headers['retry-after']).toBe('5');
    expect(hits).toBe(4);
    expect((await request(app).get('/health')).body.breakers).toEqual({ 'transaction-service': 'open' });
  });

  it('half-open: after the cooldown a few probes go through; all succeeding closes it, one failing re-opens it', async () => {
    const app = gateway();
    mode = 'unavailable';
    for (let i = 0; i < 4; i++) await call(app);
    expect((await call(app)).body.error.code).toBe('UPSTREAM_UNAVAILABLE');

    clock += 5_000;
    expect(app.locals.breakers.get('transaction-service')!.state).toBe('half-open');
    const probe = await call(app); // still failing: straight back to open
    expect(probe.status).toBe(503);
    expect(probe.body.mode).toBe('unavailable');
    expect((await call(app)).body.error.code).toBe('UPSTREAM_UNAVAILABLE');

    clock += 5_000;
    mode = 'ok';
    expect((await call(app)).status).toBe(200);
    expect(app.locals.breakers.get('transaction-service')!.state).toBe('half-open');
    expect((await call(app)).status).toBe(200);
    expect(app.locals.breakers.get('transaction-service')!.state).toBe('closed');
    for (let i = 0; i < 5; i++) expect((await call(app)).status).toBe(200);
  });

  it('application errors (4xx, 500) are not upstream failures', async () => {
    const app = gateway();
    mode = 'error';
    for (let i = 0; i < 10; i++) expect((await call(app)).status).toBe(500);
    expect(app.locals.breakers.get('transaction-service')!.state).toBe('closed');
    expect(hits).toBe(10);
  });

  it('connection errors and timeouts are failures', async () => {
    const refused = gateway('http://127.0.0.1:1');
    for (let i = 0; i < 4; i++) expect((await call(refused)).body.error.code).toBe('BAD_GATEWAY');
    expect((await call(refused)).body.error.code).toBe('UPSTREAM_UNAVAILABLE');

    mode = 'hang';
    const slow = gateway(upstreamUrl, { runtime: { upstreamTimeoutMs: 50 } });
    for (let i = 0; i < 4; i++) expect((await call(slow)).body.error.code).toBe('GATEWAY_TIMEOUT');
    expect((await call(slow)).body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('a client that leaves before the upstream answers does not count against the upstream', async () => {
    mode = 'hang';
    const app = gateway();
    const server = app.listen(0);
    const base = await listen(server);
    try {
      for (let i = 0; i < 6; i++) {
        const controller = new AbortController();
        const pending = fetch(`${base}/api/v1/transactions/x`, { signal: controller.signal }).catch(() => null);
        await sleep(20);
        controller.abort();
        await pending;
      }
      await sleep(50);
      expect(hits).toBe(6);
      expect(app.locals.breakers.get('transaction-service')!.state).toBe('closed');
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('streaming routes', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let upstreamClosed: string[] = [];

  beforeAll(async () => {
    const app = express();
    // A real-time stream: a heartbeat every 50 ms for one second, then the end
    const heartbeats = (req: express.Request, res: express.Response) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`: heartbeat ${++n}\n\n`);
        if (n === 20) {
          clearInterval(timer);
          res.end();
        }
      }, 50);
      req.on('close', () => clearInterval(timer));
    };
    app.get('/api/v1/realtime/stream', (req, res) => {
      if (!req.query.forever) return heartbeats(req, res);
      // Never ends by itself: used to check that a client leaving reaches the upstream
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      req.on('close', () => upstreamClosed.push('stream'));
    });
    // A stream that goes quiet for longer than the ordinary upstream timeout
    const quiet = (_req: express.Request, res: express.Response) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
      setTimeout(() => res.end('event: late\ndata: {}\n\n'), 600);
    };
    app.post('/api/v1/assistant/conversations/:id/messages', express.json(), (req, res) => {
      expect(req.body).toEqual({ content: 'What did I spend?' });
      quiet(req, res);
    });
    app.get('/api/v1/realtime/quiet', quiet);
    upstream = app.listen(0);
    upstreamUrl = await listen(upstream);
  });
  afterAll(() => {
    upstream.closeAllConnections?.();
    upstream.close();
  });
  beforeEach(() => {
    upstreamClosed = [];
  });

  const serve = async (extra: GatewayOptions = {}) => {
    const app = createGateway({
      routes: [
        { name: 'realtime-service', prefix: '/api/v1/realtime', target: upstreamUrl },
        { name: 'assistant-service', prefix: '/api/v1/assistant', target: upstreamUrl },
      ],
      // The ordinary upstream idle timeout is far shorter than the streams below
      runtime: { upstreamTimeoutMs: 200 },
      ...extra,
    });
    const server = app.listen(0);
    return { app, server, base: await listen(server) };
  };

  it('relays an SSE stream that outlives the default timeout, unbuffered, chunk by chunk', async () => {
    const { server, base } = await serve();
    try {
      const started = Date.now();
      const res = await fetch(`${base}/api/v1/realtime/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      const { chunks, error } = await readAll(res);
      expect(error).toBeUndefined();
      const text = chunks.map((c) => c.text).join('');
      expect(text.match(/: heartbeat \d+/g)).toHaveLength(20);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      // Not buffered: the first heartbeat arrived long before the stream ended
      expect(chunks[0].at - started).toBeLessThan(400);
      expect(chunks.length).toBeGreaterThan(5);
    } finally {
      server.close();
    }
  });

  it('has no idle timeout on streams (assistant replies included), while ordinary routes keep theirs', async () => {
    const { server, base } = await serve();
    try {
      const reply = await fetch(`${base}/api/v1/assistant/conversations/c1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'What did I spend?' }),
      });
      const streamed = await readAll(reply);
      expect(streamed.error).toBeUndefined();
      expect(streamed.chunks.map((c) => c.text).join('')).toContain('event: late');

      // The same quiet upstream on a non-streaming route is cut at the idle timeout
      const ordinary = await fetch(`${base}/api/v1/realtime/quiet`);
      const cut = await readAll(ordinary);
      expect(cut.error).toBeDefined();
      expect(cut.chunks.map((c) => c.text).join('')).not.toContain('event: late');
    } finally {
      server.close();
    }
  });

  it('cleans up both sides: a client leaving closes the upstream stream and frees the stream slot', async () => {
    const { app, server, base } = await serve();
    try {
      // Streams have no idle timeout, so only the client leaving can end this one
      const controller = new AbortController();
      const res = await fetch(`${base}/api/v1/realtime/stream?forever=1`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(app.locals.shedder.counts.streams).toBe(1);
      await sleep(300); // longer than the ordinary idle timeout: still open
      expect(upstreamClosed).toEqual([]);
      controller.abort();
      for (let i = 0; i < 100 && (!upstreamClosed.length || app.locals.shedder.counts.streams); i++) await sleep(10);
      expect(upstreamClosed).toEqual(['stream']);
      expect(app.locals.shedder.counts.streams).toBe(0);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('a stream whose upstream cannot be reached in time fails fast instead of hanging', async () => {
    // 10.255.255.1 is not routable here: the connection either hangs (connect timeout) or fails at once
    const app = createGateway({
      routes: [{ name: 'realtime-service', prefix: '/api/v1/realtime', target: 'http://10.255.255.1:9' }],
      runtime: { connectTimeoutMs: 100 },
    });
    const started = Date.now();
    const res = await request(app).get('/api/v1/realtime/stream');
    expect([502, 504]).toContain(res.status);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('forwarded headers', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  const seen: http.IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    upstream.listen(0);
    upstreamUrl = await listen(upstream);
  });
  afterAll(() => upstream.close());
  beforeEach(() => (seen.length = 0));

  const gateway = () => createGateway({ routes: [{ name: 'transaction-service', prefix: '/api/v1/transactions', target: upstreamUrl }] });

  it('continues the caller trace with this hop as the parent span, or starts one', async () => {
    const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await request(gateway()).get('/api/v1/transactions/x').set('traceparent', incoming);
    const forwarded = String(seen[0].traceparent);
    expect(forwarded).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(forwarded).not.toBe(incoming);

    await request(gateway()).get('/api/v1/transactions/x').set('traceparent', 'garbage');
    expect(String(seen[1].traceparent)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(String(seen[1].traceparent)).not.toContain('garbage');
  });

  it('still strips spoofable headers and sets the forwarding headers itself', async () => {
    await request(gateway())
      .get('/api/v1/transactions/x')
      .set('x-internal-service-token', 'guess')
      .set('x-user-role', 'BANK_ADMIN')
      .set('x-forwarded-host', 'evil.example')
      .set('x-forwarded-proto', 'https');
    expect(seen[0]['x-internal-service-token']).toBeUndefined();
    expect(seen[0]['x-user-role']).toBeUndefined();
    expect(seen[0]['x-forwarded-host']).toBeUndefined();
    expect(seen[0]['x-forwarded-proto']).toBe('http');
    expect(seen[0]['x-correlation-id']).toBeDefined();
  });

  it('labels request metrics with the upstream prefix, never the raw path', async () => {
    await request(gateway()).get('/api/v1/transactions/accounts/9f1c0d3e-attacker-chosen/history');
    const text = await metricsRegistry.metrics();
    expect(text).toContain('route="/api/v1/transactions/*"');
    expect(text).not.toContain('attacker-chosen');
  });
});
