import express from 'express';
import request from 'supertest';
import { CircuitBreaker, HttpError, ServiceClient, ServiceUnavailableError, correlationIdMiddleware, traceContextMiddleware } from '../src';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const client = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof ServiceClient>[0]> = {}) =>
  new ServiceClient({ name: 'ledger', baseUrl: 'http://ledger:8004/', fetchImpl: impl, breaker: false, ...extra });

describe('ServiceClient', () => {
  it('unwraps the platform envelope and builds the URL and query', async () => {
    const { impl, calls } = fakeFetch([json(200, { success: true, data: { balance: '100' } })]);
    const data = await client(impl).get<{ balance: string }>('/internal/v1/x', { query: { limit: 5, skip: undefined } });
    expect(data).toEqual({ balance: '100' });
    expect(calls[0].url).toBe('http://ledger:8004/internal/v1/x?limit=5');
  });

  it("passes the upstream's 4xx code and message through, without retrying", async () => {
    const { impl, calls } = fakeFetch([json(409, { error: { code: 'ACCOUNT_NOT_CREDITABLE', message: 'Account is closed' } })]);
    const error = await client(impl).get('/x').catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 409, errorCode: 'ACCOUNT_NOT_CREDITABLE', message: 'Account is closed' });
    expect(calls).toHaveLength(1);
  });

  it('retries idempotent requests on 503 and connection errors, then succeeds', async () => {
    const { impl, calls } = fakeFetch([json(503, {}), new TypeError('fetch failed'), json(200, { data: 1 })]);
    await expect(client(impl).get('/x')).resolves.toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('never retries a POST (it may have taken effect) and reports 503', async () => {
    const { impl, calls } = fakeFetch([json(503, {}, { 'retry-after': '2' }), json(200, { data: 1 })]);
    const error = (await client(impl)
      .post('/credits', { amountPaise: 5n })
      .catch((e: unknown) => e)) as ServiceUnavailableError & { retryAfter?: string };
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.retryAfter).toBe('2');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBe('{"amountPaise":"5"}');
  });

  it('times out slow upstreams', async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const { impl } = fakeFetch([hang]);
    const slowFetch = (async (url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        void impl(url, init);
      })) as unknown as typeof fetch;
    await expect(client(slowFetch, { retries: 0 }).get('/x', { timeoutMs: 20 })).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('forwards correlation id, trace, client address and (only when asked) the caller token', async () => {
    const { impl, calls } = fakeFetch([json(200, { data: 'a' }), json(200, { data: 'b' })]);
    const svc = client(impl, { internalToken: 'internal-secret-value' });
    const app = express();
    app.set('trust proxy', 1);
    app.use(correlationIdMiddleware, traceContextMiddleware);
    app.get('/', async (req, res) => {
      await svc.get('/a', { context: req });
      await svc.get('/b', { context: req, forwardAuth: true });
      res.json({ trace: req.trace });
    });

    const res = await request(app)
      .get('/')
      .set('x-correlation-id', 'corr-123')
      .set('x-forwarded-for', '198.51.100.7')
      .set('authorization', 'Bearer user-token')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
      .expect(200);

    const first = calls[0].init.headers as Record<string, string>;
    const second = calls[1].init.headers as Record<string, string>;
    expect(first['x-correlation-id']).toBe('corr-123');
    expect(first['x-forwarded-for']).toBe('198.51.100.7');
    expect(first['x-internal-service-token']).toBe('internal-secret-value');
    expect(first.traceparent).toBe(`00-0af7651916cd43dd8448eb211c80319c-${res.body.trace.spanId}-01`);
    expect(first.authorization).toBeUndefined();
    expect(second.authorization).toBe('Bearer user-token');
  });

  it('stops calling an upstream once its circuit opens', async () => {
    const failures = Array.from({ length: 30 }, () => new TypeError('fetch failed'));
    const { impl, calls } = fakeFetch(failures);
    const breaker = new CircuitBreaker({ name: 'ledger', minimumRequests: 5, failureRatio: 0.5 });
    const svc = client(impl, { breaker, retries: 0 });
    for (let i = 0; i < 5; i++) await svc.get('/x').catch(() => undefined);
    const before = calls.length;
    await expect(svc.get('/x')).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls.length).toBe(before);
  });

  it('treats an unparseable success body as a bad gateway', async () => {
    const { impl } = fakeFetch([new Response('<html>', { status: 200 })]);
    await expect(client(impl).get('/x')).rejects.toMatchObject({ statusCode: 502 });
  });
});
