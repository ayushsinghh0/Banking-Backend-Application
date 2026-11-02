// One signed-in session per VU, like a person who signs in once and keeps the app open: log in on first use,
// refresh before the access token expires (POST /auth/refresh rotates the refresh token), log in again after a
// 401. Module state is per VU in k6, so nothing here is shared between VUs.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, currentUser } from './config.js';

export const logins = new Counter('auth_logins');
export const refreshes = new Counter('auth_refreshes');

const REFRESH_MARGIN_MS = 60_000;
let session = null;

function post(path, body, name) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // Sign-in traffic is its own journey so it never skews the latency of the journeys being measured
    tags: { journey: 'auth', name },
    responseCallback: http.expectedStatuses(200),
  });
}

function adopt(user, tokens) {
  session = {
    user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? session?.refreshToken,
    expiresAt: Date.now() + (tokens.expiresInSeconds ?? 900) * 1000,
  };
}

function login(user) {
  const res = post('/api/v1/auth/login', { email: user.email, password: user.password }, 'POST /auth/login');
  logins.add(1);
  const data = res.status === 200 ? res.json('data') : null;
  const ok = check(res, { 'login: 200 with tokens': () => Boolean(data?.tokens?.accessToken) }, { journey: 'auth' });
  if (!ok) {
    session = null;
    if (data?.mfaRequired) throw new Error(`${user.email} has two-factor sign-in enabled; seed users must not`);
    return false;
  }
  adopt(user, data.tokens);
  return true;
}

function refresh() {
  const res = post('/api/v1/auth/refresh', { refreshToken: session.refreshToken }, 'POST /auth/refresh');
  refreshes.add(1);
  if (res.status === 200) {
    adopt(session.user, res.json('data'));
    return true;
  }
  return login(session.user);
}

/**
 * A valid access token for this VU's user, or null when the user cannot sign in (the caller skips the
 * iteration). `minSecondsLeft` refreshes earlier, for a request that must outlive the token's remaining life.
 */
export function accessToken(minSecondsLeft = REFRESH_MARGIN_MS / 1000) {
  const user = currentUser();
  if (!session || session.user.email !== user.email) {
    if (!login(user)) return null;
  } else if (Date.now() > session.expiresAt - minSecondsLeft * 1000) {
    if (!refresh()) return null;
  }
  return session.accessToken;
}

/** After a 401: the token was revoked or expired early; the next call signs in again */
export function dropSession() {
  session = null;
}
