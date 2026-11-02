import { http, HttpResponse, delay } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { ApiClient, type ApiClientConfig } from './client';
import { ApiError } from './errors';

const url = (path: string) => `http://localhost:3000/api/v1${path}`;
const unauthorized = (message = 'expired') =>
  HttpResponse.json({ error: { code: 'UNAUTHORIZED', message, correlationId: 'c' } }, { status: 401 });

function makeClient(overrides: Partial<ApiClientConfig> = {}) {
  let token: string | null = 'access-1';
  const config = {
    getAccessToken: () => token,
    refreshAccessToken: vi.fn(async () => {
      token = 'access-2';
      return token;
    }),
    onSessionExpired: vi.fn(),
    ...overrides,
  };
  return { client: new ApiClient(config), config };
}

describe('ApiClient', () => {
  it('sends JSON with the bearer token and returns the parsed body', async () => {
    let seen: Request | undefined;
    server.use(
      http.post(url('/accounts'), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ success: true, data: { id: 'a1' } }, { status: 201 });
      })
    );
    const { client } = makeClient();
    const body = await client.request<{ data: { id: string } }>('/accounts', {
      method: 'POST',
      body: { accountType: 'SAVINGS' },
    });
    expect(body.data.id).toBe('a1');
    expect(seen?.headers.get('authorization')).toBe('Bearer access-1');
    expect(seen?.headers.get('content-type')).toBe('application/json');
    expect(seen?.headers.get('x-session-transport')).toBe('cookie');
    expect(await seen?.json()).toEqual({ accountType: 'SAVINGS' });
  });

  it('serialises query parameters and skips empty ones', async () => {
    let seenUrl = '';
    server.use(
      http.get(url('/fraud/alerts'), ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ success: true, data: [] });
      })
    );
    await makeClient().client.request('/fraud/alerts', {
      query: { status: 'OPEN', limit: 20, offset: 0, q: '', x: undefined },
    });
    const params = new URL(seenUrl).searchParams;
    expect(params.get('status')).toBe('OPEN');
    expect(params.get('limit')).toBe('20');
    expect(params.get('offset')).toBe('0');
    expect(params.has('q')).toBe(false);
    expect(params.has('x')).toBe(false);
  });

  it('attaches the idempotency key to money-moving requests', async () => {
    let key: string | null = null;
    server.use(
      http.post(url('/transactions/transfer'), ({ request }) => {
        key = request.headers.get('idempotency-key');
        return HttpResponse.json({ success: true, data: {} }, { status: 201 });
      })
    );
    await makeClient().client.request('/transactions/transfer', {
      method: 'POST',
      body: {},
      idempotencyKey: 'key-12345678',
    });
    expect(key).toBe('key-12345678');
  });

  it('omits the token on public endpoints', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.post(url('/auth/login'), ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ success: true, data: {} });
      })
    );
    await makeClient().client.request('/auth/login', { method: 'POST', body: {}, auth: false });
    expect(auth).toBeNull();
  });

  it('maps API errors to ApiError with code, message, correlation id and field details', async () => {
    server.use(
      http.post(url('/auth/register'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid input parameters',
              correlationId: 'corr-1',
              details: [{ field: 'password', message: 'Password must be at least 10 characters long' }],
            },
          },
          { status: 400 }
        )
      )
    );
    const err = await makeClient()
      .client.request('/auth/register', { method: 'POST', body: {}, auth: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.correlationId).toBe('corr-1');
    expect(apiError.fieldErrors).toEqual({ password: 'Password must be at least 10 characters long' });
  });

  it('reads Retry-After on busy responses', async () => {
    server.use(
      http.post(url('/transactions/transfer'), () =>
        HttpResponse.json(
          { error: { code: 'SERVICE_BUSY', message: 'busy', correlationId: 'c' } },
          { status: 503, headers: { 'Retry-After': '2' } }
        )
      )
    );
    const err = (await makeClient()
      .client.request('/transactions/transfer', { method: 'POST', body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('SERVICE_BUSY');
    expect(err.retryAfterSeconds).toBe(2);
    expect(err.isRetryable).toBe(true);
  });

  it('handles non-JSON error bodies (e.g. an HTML 502 from a proxy)', async () => {
    server.use(http.get(url('/accounts'), () => new HttpResponse('<html>Bad gateway</html>', { status: 502 })));
    const err = (await makeClient().client.request('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('BAD_GATEWAY');
  });

  it('refreshes once on 401 and retries the original request with the new token', async () => {
    const tokens: Array<string | null> = [];
    server.use(
      http.get(url('/accounts'), ({ request }) => {
        const auth = request.headers.get('authorization');
        tokens.push(auth);
        if (auth === 'Bearer access-1') return unauthorized();
        return HttpResponse.json({ success: true, data: ['ok'] });
      })
    );
    const { client, config } = makeClient();
    const body = await client.request<{ data: string[] }>('/accounts');
    expect(body.data).toEqual(['ok']);
    expect(tokens).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(config.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(config.onSessionExpired).not.toHaveBeenCalled();
  });

  it('expires the session when refresh fails', async () => {
    server.use(http.get(url('/accounts'), () => unauthorized()));
    const { client, config } = makeClient({ refreshAccessToken: vi.fn(async () => null) });
    const err = (await client.request('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(config.onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('expires the session when the retried request is still unauthorised', async () => {
    server.use(http.get(url('/accounts'), () => unauthorized('revoked')));
    const { client, config } = makeClient();
    await expect(client.request('/accounts')).rejects.toBeInstanceOf(ApiError);
    expect(config.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(config.onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('surfaces a transient refresh failure without signing the user out', async () => {
    server.use(http.get(url('/accounts'), () => unauthorized()));
    const offline = new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline' });
    const { client, config } = makeClient({ refreshAccessToken: vi.fn(async () => Promise.reject(offline)) });
    await expect(client.request('/accounts')).rejects.toBe(offline);
    expect(config.onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not try to refresh for public endpoints', async () => {
    server.use(http.post(url('/auth/login'), () => unauthorized('Invalid email or password')));
    const { client, config } = makeClient();
    await expect(client.request('/auth/login', { method: 'POST', body: {}, auth: false })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(config.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('expires the session without calling the server when there is no token at all', async () => {
    const { client, config } = makeClient({ getAccessToken: () => null, refreshAccessToken: vi.fn(async () => null) });
    const err = (await client.request('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(config.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(config.onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('turns network failures into a NETWORK_ERROR', async () => {
    server.use(http.get(url('/accounts'), () => HttpResponse.error()));
    const err = (await makeClient().client.request('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
    expect(err.isRetryable).toBe(true);
  });

  it('times out slow requests', async () => {
    server.use(
      http.get(url('/accounts'), async () => {
        await delay(200);
        return HttpResponse.json({ success: true });
      })
    );
    const { client } = makeClient({ timeoutMs: 20 });
    const err = (await client.request('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('TIMEOUT');
  });

  it('propagates caller aborts untouched so queries can cancel', async () => {
    server.use(
      http.get(url('/accounts'), async () => {
        await delay(200);
        return HttpResponse.json({ success: true });
      })
    );
    const controller = new AbortController();
    const pending = makeClient().client.request('/accounts', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns undefined for empty successful responses', async () => {
    server.use(http.delete(url('/transactions/beneficiaries/b1'), () => new HttpResponse(null, { status: 204 })));
    await expect(
      makeClient().client.request('/transactions/beneficiaries/b1', { method: 'DELETE' })
    ).resolves.toBeUndefined();
  });
});

describe('ApiClient.stream', () => {
  const sse = (body: string) =>
    new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });

  it('opens an event stream with the bearer token and returns the raw response', async () => {
    let seen: Request | undefined;
    server.use(
      http.post(url('/assistant/conversations/c1/messages'), ({ request }) => {
        seen = request.clone();
        return sse('event: token\ndata: {"text":"Hi"}\n\n');
      })
    );
    const response = await makeClient().client.stream('/assistant/conversations/c1/messages', {
      method: 'POST',
      body: { content: 'Hello' },
      headers: { 'Last-Event-ID': '41' },
    });
    expect(await response.text()).toContain('event: token');
    expect(seen?.headers.get('authorization')).toBe('Bearer access-1');
    expect(seen?.headers.get('accept')).toBe('text/event-stream');
    expect(seen?.headers.get('last-event-id')).toBe('41');
    expect(await seen?.json()).toEqual({ content: 'Hello' });
  });

  it('renews an expired token once and opens the stream again', async () => {
    const auth: Array<string | null> = [];
    server.use(
      http.get(url('/realtime/stream'), ({ request }) => {
        auth.push(request.headers.get('authorization'));
        return auth.length === 1 ? unauthorized() : sse(': hello\n\n');
      })
    );
    const { client, config } = makeClient();
    const response = await client.stream('/realtime/stream');
    expect(response.ok).toBe(true);
    expect(auth).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(config.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('maps an error response to an ApiError with Retry-After', async () => {
    server.use(
      http.get(url('/realtime/stream'), () =>
        HttpResponse.json({ error: { code: 'TOO_MANY_STREAMS', message: 'At most 5 streams' } }, { status: 429, headers: { 'Retry-After': '7' } })
      )
    );
    const err = (await makeClient().client.stream('/realtime/stream').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TOO_MANY_STREAMS');
    expect(err.retryAfterSeconds).toBe(7);
  });

  it('times out only while connecting, never while the stream is open', async () => {
    server.use(
      http.get(url('/realtime/stream'), async () => {
        await delay(200);
        return sse(': late\n\n');
      })
    );
    const err = (await makeClient({ timeoutMs: 20 }).client.stream('/realtime/stream').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('TIMEOUT');

    server.use(
      http.get(url('/realtime/stream'), () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await delay(60);
            controller.enqueue(encoder.encode(': still here\n\n'));
            controller.close();
          },
        });
        return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
      })
    );
    const response = await makeClient({ timeoutMs: 20 }).client.stream('/realtime/stream');
    expect(await response.text()).toBe(': still here\n\n');
  });

  it('reports a failed connection as a NETWORK_ERROR and a caller abort as an AbortError', async () => {
    server.use(http.get(url('/realtime/stream'), () => HttpResponse.error()));
    const err = (await makeClient().client.stream('/realtime/stream').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('NETWORK_ERROR');

    server.use(
      http.get(url('/realtime/stream'), async () => {
        await delay(200);
        return sse('');
      })
    );
    const controller = new AbortController();
    const pending = makeClient().client.stream('/realtime/stream', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
