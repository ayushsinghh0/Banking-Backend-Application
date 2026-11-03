import { http, HttpResponse, delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { makeAccessToken } from '@/test/tokens';
import { ApiError } from '@/lib/api/errors';
import { SessionStore, decodeAccessToken, hasFreshStepUp } from './session';

const REFRESH = 'http://localhost:3000/api/v1/auth/refresh';
const LOGOUT = 'http://localhost:3000/api/v1/auth/logout';

describe('decodeAccessToken', () => {
  it('reads the identity claims without verifying (the server verifies)', () => {
    const token = makeAccessToken({ sub: 'u1', email: 'a@x.in', role: 'CUSTOMER', mfa: true, stepUpAt: 100, mfaSince: 50 });
    expect(decodeAccessToken(token)).toMatchObject({
      id: 'u1',
      email: 'a@x.in',
      role: 'CUSTOMER',
      mfa: true,
      stepUpAt: 100,
      mfaSince: 50,
    });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeAccessToken('nope')).toBeNull();
    expect(decodeAccessToken('a.b.c')).toBeNull();
    expect(decodeAccessToken(`x.${btoa(JSON.stringify({ sub: 'u1' }))}.y`)).toBeNull();
  });
});

describe('hasFreshStepUp', () => {
  it('is true only within the step-up window, with a safety margin', () => {
    const now = 1_000_000;
    expect(hasFreshStepUp({ mfa: true, stepUpAt: now - 100 }, now)).toBe(true);
    expect(hasFreshStepUp({ mfa: true, stepUpAt: now - 290 }, now)).toBe(false);
    expect(hasFreshStepUp({ mfa: true }, now)).toBe(false);
    expect(hasFreshStepUp({ mfa: false, stepUpAt: now }, now)).toBe(false);
  });
});

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ channelName: `test-${Math.random()}` });
  });
  afterEach(() => store.dispose());

  it('starts unknown, becomes authenticated with a token and notifies listeners', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.status).toBe('unknown');
    store.setAccessToken(makeAccessToken({ role: 'TELLER', mfa: true }));
    expect(store.status).toBe('authenticated');
    expect(store.user?.role).toBe('TELLER');
    expect(listener).toHaveBeenCalled();
  });

  it('refreshes through the HttpOnly cookie and stores the new access token', async () => {
    let seen: Request | undefined;
    const fresh = makeAccessToken({ sub: 'u9' });
    server.use(
      http.post(REFRESH, ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ success: true, data: { accessToken: fresh, expiresInSeconds: 900 } });
      })
    );
    await expect(store.refresh()).resolves.toBe(fresh);
    expect(store.user?.id).toBe('u9');
    expect(seen?.headers.get('x-session-transport')).toBe('cookie');
    expect(await seen?.json()).toEqual({});
  });

  it('shares one refresh between concurrent callers', async () => {
    let calls = 0;
    const fresh = makeAccessToken();
    server.use(
      http.post(REFRESH, async () => {
        calls++;
        await delay(20);
        return HttpResponse.json({ success: true, data: { accessToken: fresh, expiresInSeconds: 900 } });
      })
    );
    const results = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(results).toEqual([fresh, fresh, fresh]);
    expect(calls).toBe(1);
  });

  it('retries once when another tab is refreshing at the same moment (409)', async () => {
    let calls = 0;
    const fresh = makeAccessToken();
    server.use(
      http.post(REFRESH, () => {
        calls++;
        if (calls === 1) {
          return HttpResponse.json({ error: { code: 'REFRESH_IN_PROGRESS', message: 'retry', correlationId: 'c' } }, { status: 409 });
        }
        return HttpResponse.json({ success: true, data: { accessToken: fresh, expiresInSeconds: 900 } });
      })
    );
    await expect(store.refresh()).resolves.toBe(fresh);
    expect(calls).toBe(2);
  });

  it('becomes anonymous when the session cannot be renewed', async () => {
    store.setAccessToken(makeAccessToken());
    server.use(
      http.post(REFRESH, () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: 'gone', correlationId: 'c' } }, { status: 401 })
      )
    );
    await expect(store.refresh()).resolves.toBeNull();
    expect(store.status).toBe('anonymous');
    expect(store.getAccessToken()).toBeNull();
  });

  it('throws (and keeps the session) on transient failures such as being offline', async () => {
    store.setAccessToken(makeAccessToken());
    server.use(http.post(REFRESH, () => HttpResponse.error()));
    await expect(store.refresh()).rejects.toBeInstanceOf(ApiError);
    expect(store.status).toBe('authenticated');
  });

  it('restores a session on start-up, or settles on anonymous when there is none', async () => {
    server.use(
      http.post(REFRESH, () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: 'no session', correlationId: 'c' } }, { status: 401 })
      )
    );
    await store.restore();
    expect(store.status).toBe('anonymous');
  });

  it('treats an unreachable server at start-up as signed out rather than hanging', async () => {
    server.use(http.post(REFRESH, () => HttpResponse.error()));
    await store.restore();
    expect(store.status).toBe('anonymous');
  });

  it('logs out on the server, clears memory and tells other tabs', async () => {
    let auth: string | null = null;
    server.use(
      http.post(LOGOUT, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ success: true });
      })
    );
    const channel = `shared-${Math.random()}`;
    const tabA = new SessionStore({ channelName: channel });
    const tabB = new SessionStore({ channelName: channel });
    const token = makeAccessToken();
    tabA.setAccessToken(token);
    tabB.setAccessToken(makeAccessToken());

    await tabA.logout();
    expect(auth).toBe(`Bearer ${token}`);
    expect(tabA.status).toBe('anonymous');
    await vi.waitFor(() => expect(tabB.status).toBe('anonymous'));
    tabA.dispose();
    tabB.dispose();
  });

  it('still signs out locally when the logout request fails', async () => {
    server.use(http.post(LOGOUT, () => HttpResponse.error()));
    store.setAccessToken(makeAccessToken());
    await store.logout();
    expect(store.status).toBe('anonymous');
  });

  it('refreshes proactively a minute before the access token expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const now = Math.floor(Date.now() / 1000);
      const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(null);
      store.setAccessToken(makeAccessToken({ exp: now + 120 }));
      vi.advanceTimersByTime(59_000);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
