import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { ConsoleMailer, InMemoryTokenStateStore, UserRole, generateJwtKeyPair, signAccessToken, verifyAccessToken } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { createApp } from '../src/app';
import { AuthService } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { InMemoryEdgeSecurityStore } from '../src/services/edge-security.store';
import { KNOWN_DEVICE_DAYS, TOUCH_INTERVAL_MS } from '../src/services/sessions';
import { encryptSecret, generateTotpSecret, totpAt, currentStep } from '../src/services/totp';
import { FakePrisma } from './support/fake-prisma';

jest.setTimeout(60_000); // every sign-in is a real Argon2id verification

const ALICE = '4b1d2c3e-5f60-4718-8a9b-0c1d2e3f4a5b';
const BOB = '7e8f9a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b';
const PASSWORD = 'Password1234';
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
const DAY = 86_400_000;

type Client = { ip: string; userAgent?: string };
const DESKTOP: Client = { ip: '203.0.113.7', userAgent: CHROME_WINDOWS };
const PHONE: Client = { ip: '2001:db8:1:2::5', userAgent: SAFARI_IPHONE };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const staffToken = (role: UserRole) =>
  signAccessToken({ sub: `${role.toLowerCase()}-1`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: true, sessionId: crypto.randomUUID() });

interface Harness {
  app: express.Express;
  prisma: FakePrisma;
  tokenState: InMemoryTokenStateStore;
  authService: AuthService;
  mailer: ConsoleMailer;
}

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await PasswordService.hash(PASSWORD);
  // The service sits behind the gateway, which overwrites X-Forwarded-For with the client address
  process.env.TRUST_PROXY = '1';
});

afterAll(() => {
  delete process.env.TRUST_PROXY;
});

function build(): Harness {
  const prisma = new FakePrisma();
  const tokenState = new InMemoryTokenStateStore();
  const mailer = new ConsoleMailer();
  const { app, authService } = createApp(prisma as unknown as PrismaClient, {
    tokenState,
    security: new InMemoryAuthSecurityStore(),
    mailer,
    edge: new InMemoryEdgeSecurityStore(),
  });
  prisma.seed('user', [{ id: ALICE, email: 'alice@example.com', passwordHash, isEmailVerified: true }]);
  return { app, prisma, tokenState, authService, mailer };
}

const withClient = (req: request.Test, client: Client) => {
  req.set('X-Forwarded-For', client.ip);
  if (client.userAgent) req.set('User-Agent', client.userAgent);
  return req;
};

/** Password sign-in as a given device; returns the tokens (or the MFA challenge) */
async function signIn(h: Harness, client: Client, credentials: { email?: string; password?: string } = {}) {
  const res = await withClient(request(h.app).post('/api/v1/auth/login'), client).send({ email: credentials.email ?? 'alice@example.com', password: credentials.password ?? PASSWORD });
  return res;
}

const tokensOf = (res: request.Response) => res.body.data.tokens as { accessToken: string; refreshToken: string };
const sessionOf = (res: request.Response) => verifyAccessToken(tokensOf(res).accessToken).sessionId!;
const eventsOf = (h: Harness, type: string) => h.prisma.tables.securityEvent.filter((e) => e.type === type);

describe('sessions (own)', () => {
  it('lists the active sessions, the current one first, with a device label and only the network part of the address', async () => {
    const h = build();
    const desktop = await signIn(h, DESKTOP);
    expect(desktop.status).toBe(200);
    const phone = await signIn(h, PHONE);
    expect(phone.status).toBe(200);

    const res = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(phone).accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: sessionOf(phone), current: true, deviceLabel: 'Safari on iPhone', ipMasked: '2001:db8:1::/48', createdAt: expect.any(String), lastSeenAt: expect.any(String), mfa: false },
      { id: sessionOf(desktop), current: false, deviceLabel: 'Chrome on Windows', ipMasked: '203.0.113.x', createdAt: expect.any(String), lastSeenAt: expect.any(String), mfa: false },
    ]);
    // Full addresses and user agents are stored for investigations but never shown
    expect(JSON.stringify(res.body)).not.toMatch(/203\.0\.113\.7|2001:db8:1:2::5|Mozilla/);
    // Seen from the desktop, the order flips: the request's own session is always first
    const fromDesktop = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(desktop).accessToken));
    expect(fromDesktop.body.data.map((s: { id: string; current: boolean }) => [s.id, s.current])).toEqual([[sessionOf(desktop), true], [sessionOf(phone), false]]);
  });

  it('hides sessions that were revoked, outlived their absolute lifetime or went idle past the refresh window', async () => {
    const h = build();
    const current = await signIn(h, DESKTOP);
    const now = Date.now();
    h.prisma.seed('userSession', [
      { userId: ALICE, expiresAt: new Date(now + DAY), deviceLabel: 'Edge on Windows', browser: 'Edge', os: 'Windows', revokedAt: new Date(), revokedReason: 'LOGOUT' },
      { userId: ALICE, expiresAt: new Date(now - 1_000), deviceLabel: 'Edge on Windows', browser: 'Edge', os: 'Windows' },
      { userId: ALICE, expiresAt: new Date(now + DAY), lastSeenAt: new Date(now - 8 * DAY), deviceLabel: 'Edge on Windows', browser: 'Edge', os: 'Windows' },
      { userId: BOB, expiresAt: new Date(now + DAY), deviceLabel: 'Edge on Windows', browser: 'Edge', os: 'Windows' },
    ]);
    const res = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(current).accessToken));
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([sessionOf(current)]);
  });

  it('revokes one session: its refresh family and its access tokens die at once, the others go on, and it is recorded', async () => {
    const h = build();
    const desktop = await signIn(h, DESKTOP);
    const phone = await signIn(h, PHONE);
    const desktopSession = sessionOf(desktop);

    const res = await withClient(request(h.app).delete(`/api/v1/auth/sessions/${desktopSession}`), PHONE).set(bearer(tokensOf(phone).accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: desktopSession, revoked: true } });

    // The desktop's access token is refused immediately (session denylist), not at expiry
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(desktop).accessToken))).status).toBe(401);
    expect(await h.tokenState.isAccessTokenRevoked({ userId: ALICE, jti: 'any', tokenVersion: 0, sessionId: desktopSession })).toBe(true);
    // Its refresh token no longer rotates
    expect((await request(h.app).post('/api/v1/auth/refresh').send({ refreshToken: tokensOf(desktop).refreshToken })).status).toBe(401);
    expect(h.prisma.tables.refreshToken.filter((t) => t.familyId === desktopSession).every((t) => t.isRevoked)).toBe(true);
    // The phone is untouched
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(phone).accessToken))).status).toBe(200);
    const listed = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(phone).accessToken));
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([sessionOf(phone)]);

    expect(h.prisma.tables.userSession.find((s) => s.id === desktopSession)).toEqual(expect.objectContaining({ revokedAt: expect.any(Date), revokedReason: 'USER_REVOKED' }));
    // The event names the device that was signed out and the address of the request that did it
    expect(eventsOf(h, 'SESSION_REVOKED')).toEqual([
      expect.objectContaining({ userId: ALICE, ip: PHONE.ip, deviceLabel: 'Chrome on Windows', details: { reason: 'USER_REVOKED', sessionId: desktopSession } }),
    ]);

    // Idempotent, and never someone else's: a revoked session answers revoked:false, an unknown one 404
    expect((await request(h.app).delete(`/api/v1/auth/sessions/${desktopSession}`).set(bearer(tokensOf(phone).accessToken))).body.data).toEqual({ id: desktopSession, revoked: false });
    expect((await request(h.app).delete(`/api/v1/auth/sessions/${crypto.randomUUID()}`).set(bearer(tokensOf(phone).accessToken))).status).toBe(404);
    expect((await request(h.app).delete('/api/v1/auth/sessions/not-a-uuid').set(bearer(tokensOf(phone).accessToken))).status).toBe(400);
    expect(eventsOf(h, 'SESSION_REVOKED')).toHaveLength(1);
  });

  it('a user may sign their current session out through the same route', async () => {
    const h = build();
    const phone = await signIn(h, PHONE);
    const res = await request(h.app).delete(`/api/v1/auth/sessions/${sessionOf(phone)}`).set(bearer(tokensOf(phone).accessToken));
    expect(res.body.data).toEqual({ id: sessionOf(phone), revoked: true });
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(phone).accessToken))).status).toBe(401);
  });

  it('"sign out everywhere else" ends every other session and reports how many were live', async () => {
    const h = build();
    const first = await signIn(h, DESKTOP);
    const second = await signIn(h, { ip: '198.51.100.4', userAgent: FIREFOX_WINDOWS });
    const phone = await signIn(h, PHONE);

    const res = await withClient(request(h.app).post('/api/v1/auth/sessions/revoke-others'), PHONE).set(bearer(tokensOf(phone).accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: 2 });

    for (const other of [first, second]) {
      expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(other).accessToken))).status).toBe(401);
      expect((await request(h.app).post('/api/v1/auth/refresh').send({ refreshToken: tokensOf(other).refreshToken })).status).toBe(401);
      expect(h.prisma.tables.userSession.find((s) => s.id === sessionOf(other))!.revokedReason).toBe('USER_REVOKED_OTHERS');
    }
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(phone).accessToken))).status).toBe(200);
    const listed = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(phone).accessToken));
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([sessionOf(phone)]);
    expect(eventsOf(h, 'SESSION_REVOKED')).toEqual([
      expect.objectContaining({ userId: ALICE, ip: PHONE.ip, deviceLabel: 'Safari on iPhone', details: { reason: 'USER_REVOKED_OTHERS', count: 2 } }),
    ]);
    // Nothing left to end
    expect((await request(h.app).post('/api/v1/auth/sessions/revoke-others').set(bearer(tokensOf(phone).accessToken))).body.data).toEqual({ revoked: 0 });
    expect(eventsOf(h, 'SESSION_REVOKED')).toHaveLength(1);
  });

  it('records when a session was last used, at most once a minute, and adopts families that predate session records', async () => {
    const h = build();
    const login = await signIn(h, DESKTOP);
    const sessionId = sessionOf(login);
    const row = () => h.prisma.tables.userSession.find((s) => s.id === sessionId)!;
    const seenAtLogin = row().lastSeenAt.getTime();

    // Refreshed seconds after signing in: the row is not touched (one less write per refresh)
    let refresh = await request(h.app).post('/api/v1/auth/refresh').set('X-Forwarded-For', '203.0.113.8').send({ refreshToken: tokensOf(login).refreshToken });
    expect(refresh.status).toBe(200);
    expect(row().lastSeenAt.getTime()).toBe(seenAtLogin);
    expect(row().lastIp).toBe('203.0.113.7');

    // Over a minute since the last write: the refresh records the time and the current address
    row().lastSeenAt = new Date(Date.now() - TOUCH_INTERVAL_MS - 1_000);
    refresh = await request(h.app).post('/api/v1/auth/refresh').set('X-Forwarded-For', '203.0.113.8').send({ refreshToken: refresh.body.data.refreshToken });
    expect(refresh.status).toBe(200);
    expect(Date.now() - row().lastSeenAt.getTime()).toBeLessThan(5_000);
    expect(row().lastIp).toBe('203.0.113.8');
    expect(row().firstIp).toBe('203.0.113.7');

    // A family from before user_sessions existed gets its row on its next refresh
    h.prisma.tables.userSession = h.prisma.tables.userSession.filter((s) => s.id !== sessionId);
    refresh = await withClient(request(h.app).post('/api/v1/auth/refresh'), PHONE).send({ refreshToken: refresh.body.data.refreshToken });
    expect(refresh.status).toBe(200);
    expect(row()).toEqual(expect.objectContaining({ userId: ALICE, deviceLabel: 'Safari on iPhone', firstIp: PHONE.ip, mfa: false }));
  });
});

describe('security events (own history)', () => {
  it('records failed and successful sign-ins and password changes, newest first, without the raw address or user id', async () => {
    const h = build();
    const failed = await signIn(h, DESKTOP, { password: 'WrongPassword1' });
    expect(failed.status).toBe(401);
    await h.authService.drainBackgroundTasks(); // the failure is recorded after the response, so timing reveals nothing

    const ok = await signIn(h, DESKTOP);
    const changed = await withClient(request(h.app).post('/api/v1/auth/password/change'), DESKTOP)
      .set(bearer(tokensOf(ok).accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassword5678' });
    expect(changed.status).toBe(200);

    const res = await request(h.app).get('/api/v1/auth/security-events?limit=10').set(bearer(tokensOf(changed).accessToken));
    expect(res.status).toBe(200);
    const events = res.body.data as Array<{ type: string; at: string; details: Record<string, unknown> }>;
    expect(events.map((e) => e.type).sort()).toEqual(['PASSWORD_CHANGED', 'SIGN_IN_FAILED', 'SIGN_IN_SUCCEEDED']);
    for (let i = 1; i < events.length; i++) expect(Date.parse(events[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(events[i].at));
    const byType = Object.fromEntries(events.map((e) => [e.type, e]));
    expect(byType.SIGN_IN_FAILED).toEqual({ id: expect.any(String), type: 'SIGN_IN_FAILED', deviceLabel: 'Chrome on Windows', ipMasked: '203.0.113.x', at: expect.any(String), details: { reason: 'INVALID_PASSWORD' } });
    expect(byType.SIGN_IN_SUCCEEDED.details).toEqual({ mfa: false, newDevice: false });
    expect(byType.PASSWORD_CHANGED.details).toEqual({ via: 'CHANGE' });
    expect(JSON.stringify(res.body)).not.toMatch(/203\.0\.113\.7|userId/);
  });

  it('records a wrong second-factor code against the account, and the completed MFA sign-in as such', async () => {
    const h = build();
    const secret = generateTotpSecret();
    h.prisma.seed('user', [{ id: BOB, email: 'bob@example.com', passwordHash, isEmailVerified: true, mfaEnabled: true, mfaEnabledAt: new Date(Date.now() - DAY), mfaSecretEnc: encryptSecret(secret, BOB) }]);

    const step1 = await signIn(h, DESKTOP, { email: 'bob@example.com' });
    expect(step1.body.data.mfaRequired).toBe(true);
    const good = totpAt(secret, currentStep());
    const wrong = good === '000000' ? '000001' : '000000';
    const failed = await withClient(request(h.app).post('/api/v1/auth/login/mfa'), DESKTOP).send({ challengeToken: step1.body.data.challengeToken, code: wrong });
    expect(failed.status).toBe(401);
    await h.authService.drainBackgroundTasks();
    expect(eventsOf(h, 'MFA_FAILED')).toEqual([expect.objectContaining({ userId: BOB, ip: DESKTOP.ip, deviceLabel: 'Chrome on Windows', details: { context: 'SIGN_IN', locked: false } })]);

    const done = await withClient(request(h.app).post('/api/v1/auth/login/mfa'), DESKTOP).send({ challengeToken: step1.body.data.challengeToken, code: good });
    expect(done.status).toBe(200);
    expect(eventsOf(h, 'SIGN_IN_SUCCEEDED').filter((e) => e.userId === BOB).map((e) => e.details)).toEqual([{ mfa: true, newDevice: false }]);
    const sessions = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(done).accessToken));
    expect(sessions.body.data).toEqual([expect.objectContaining({ current: true, mfa: true })]);
    // Bob's history is Bob's only
    const own = await request(h.app).get('/api/v1/auth/security-events').set(bearer(tokensOf(done).accessToken));
    expect(own.body.data.map((e: { type: string }) => e.type).sort()).toEqual(['MFA_FAILED', 'SIGN_IN_SUCCEEDED']);
  });

  it('bounds the page size', async () => {
    const h = build();
    const ok = await signIn(h, DESKTOP);
    for (const limit of ['0', '51', 'many']) {
      expect((await request(h.app).get(`/api/v1/auth/security-events?limit=${limit}`).set(bearer(tokensOf(ok).accessToken))).status).toBe(400);
    }
    expect((await request(h.app).get('/api/v1/auth/security-events?limit=50').set(bearer(tokensOf(ok).accessToken))).status).toBe(200);
  });
});

describe('staff views of a user (audited)', () => {
  it('SUPPORT and BANK_ADMIN read a user’s sessions; each read is an audit row; unknown users are 404', async () => {
    const h = build();
    await signIn(h, DESKTOP);
    await signIn(h, PHONE);
    const res = await request(h.app).get(`/api/v1/auth/admin/users/${ALICE}/sessions`).set(bearer(staffToken('SUPPORT')));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((s: { current: boolean }) => s.current === false)).toBe(true);
    expect(h.prisma.tables.auditLog).toEqual([
      expect.objectContaining({ actorId: 'support-1', action: 'ADMIN_SESSIONS_VIEWED', targetId: ALICE, details: { sessions: 2 }, hash: expect.any(String) }),
    ]);
    expect((await request(h.app).get(`/api/v1/auth/admin/users/${crypto.randomUUID()}/sessions`).set(bearer(staffToken('SUPPORT')))).status).toBe(404);
    expect(h.prisma.tables.auditLog).toHaveLength(1);
    expect((await request(h.app).get(`/api/v1/auth/admin/users/${ALICE}/sessions`).set(bearer(staffToken('FRAUD_ANALYST')))).status).toBe(403);
  });

  it('only BANK_ADMIN ends a user’s session; the audit row commits with the revocation and the event says who did it', async () => {
    const h = build();
    const desktop = await signIn(h, DESKTOP);
    const phone = await signIn(h, PHONE);
    const target = sessionOf(desktop);

    const refused = await request(h.app).delete(`/api/v1/auth/admin/users/${ALICE}/sessions/${target}`).set(bearer(staffToken('SUPPORT')));
    expect(refused.status).toBe(403);
    expect(h.prisma.tables.userSession.find((s) => s.id === target)!.revokedAt).toBeNull();

    const res = await request(h.app).delete(`/api/v1/auth/admin/users/${ALICE}/sessions/${target}`).set('X-Forwarded-For', '10.20.1.5').set(bearer(staffToken('BANK_ADMIN')));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: target, revoked: true });
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(desktop).accessToken))).status).toBe(401);
    expect((await request(h.app).get('/api/v1/auth/me').set(bearer(tokensOf(phone).accessToken))).status).toBe(200);
    expect(h.prisma.tables.auditLog).toEqual([expect.objectContaining({ actorId: 'bank_admin-1', action: 'ADMIN_SESSION_REVOKED', targetId: ALICE, details: { sessionId: target } })]);
    expect(eventsOf(h, 'SESSION_REVOKED')).toEqual([expect.objectContaining({ userId: ALICE, ip: '10.20.1.5', deviceLabel: 'Chrome on Windows', details: { reason: 'ADMIN_REVOKED', sessionId: target } })]);

    // A session of another user under this user's id is not found (never revoked across users)
    h.prisma.seed('user', [{ id: BOB, email: 'bob@example.com', passwordHash }]);
    const bobs = h.prisma.seed('userSession', [{ userId: BOB, expiresAt: new Date(Date.now() + DAY), deviceLabel: 'Edge on Windows', browser: 'Edge', os: 'Windows' }])[0];
    expect((await request(h.app).delete(`/api/v1/auth/admin/users/${ALICE}/sessions/${bobs.id}`).set(bearer(staffToken('BANK_ADMIN')))).status).toBe(404);
    expect(h.prisma.tables.userSession.find((s) => s.id === bobs.id)!.revokedAt).toBeNull();
  });

  it('staff browse security events by type and user with keyset pages; every page is audited', async () => {
    const h = build();
    await signIn(h, DESKTOP, { password: 'WrongPassword1' });
    await h.authService.drainBackgroundTasks();
    await signIn(h, DESKTOP);
    await signIn(h, PHONE);
    const admin = bearer(staffToken('BANK_ADMIN'));

    const page1 = await request(h.app).get(`/api/v1/auth/admin/security-events?type=SIGN_IN_SUCCEEDED&userId=${ALICE}&limit=1`).set(admin);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toEqual([expect.objectContaining({ userId: ALICE, type: 'SIGN_IN_SUCCEEDED', deviceLabel: 'Safari on iPhone', ipMasked: '2001:db8:1::/48' })]);
    expect(page1.body.pagination).toEqual({ limit: 1, nextCursor: expect.any(String) });
    const page2 = await request(h.app).get(`/api/v1/auth/admin/security-events?type=SIGN_IN_SUCCEEDED&userId=${ALICE}&limit=1&cursor=${page1.body.pagination.nextCursor}`).set(admin);
    expect(page2.body.data).toEqual([expect.objectContaining({ type: 'SIGN_IN_SUCCEEDED', deviceLabel: 'Chrome on Windows' })]);
    expect(page2.body.pagination.nextCursor).toBeNull();
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);

    const all = await request(h.app).get('/api/v1/auth/admin/security-events').set(bearer(staffToken('FRAUD_ANALYST')));
    expect(all.body.data.map((e: { type: string }) => e.type).sort()).toEqual(['NEW_DEVICE', 'SIGN_IN_FAILED', 'SIGN_IN_SUCCEEDED', 'SIGN_IN_SUCCEEDED']);
    expect(all.body.pagination).toEqual({ limit: 50, nextCursor: null });

    expect(h.prisma.tables.auditLog.map((a) => [a.actorId, a.action, a.targetId, a.details])).toEqual([
      ['bank_admin-1', 'ADMIN_SECURITY_EVENTS_VIEWED', ALICE, { type: 'SIGN_IN_SUCCEEDED', limit: 1, paged: false, events: 1 }],
      ['bank_admin-1', 'ADMIN_SECURITY_EVENTS_VIEWED', ALICE, { type: 'SIGN_IN_SUCCEEDED', limit: 1, paged: true, events: 1 }],
      ['fraud_analyst-1', 'ADMIN_SECURITY_EVENTS_VIEWED', null, { type: null, limit: 50, paged: false, events: 4 }],
    ]);

    expect((await request(h.app).get('/api/v1/auth/admin/security-events?cursor=not-a-cursor').set(admin)).status).toBe(400);
    expect((await request(h.app).get('/api/v1/auth/admin/security-events?type=SOMETHING_ELSE').set(admin)).status).toBe(400);
    expect((await request(h.app).get('/api/v1/auth/admin/security-events?limit=101').set(admin)).status).toBe(400);
    expect((await request(h.app).get('/api/v1/auth/admin/security-events').set(bearer(staffToken('TELLER')))).status).toBe(403);
  });
});

describe('new-device sign-in', () => {
  const newDeviceEvents = (h: Harness) => eventsOf(h, 'NEW_DEVICE');
  const alerts = (h: Harness) => h.prisma.tables.outboxEvent.filter((e) => e.eventType === 'security.new_device_login.v1');
  const lastSignIn = (h: Harness) => eventsOf(h, 'SIGN_IN_SUCCEEDED').at(-1)!;

  it('is the same browser and OS family from the same network within 90 days; anything else alerts the account holder', async () => {
    const h = build();
    // The account's very first session is never a new device
    await signIn(h, DESKTOP);
    expect(newDeviceEvents(h)).toHaveLength(0);
    expect(lastSignIn(h).details).toEqual({ mfa: false, newDevice: false });
    expect(h.prisma.tables.user.find((u) => u.id === ALICE)!.firstSignInAt).toBeInstanceOf(Date);

    // A browser update, another host on the same /24: known
    await signIn(h, { ip: '203.0.113.99', userAgent: CHROME_WINDOWS.replace('Chrome/130.0.0.0', 'Chrome/131.0.0.0') });
    expect(newDeviceEvents(h)).toHaveLength(0);

    // Another browser on the same machine: new device
    const firefox = await signIn(h, { ip: '203.0.113.7', userAgent: FIREFOX_WINDOWS });
    expect(firefox.status).toBe(200);
    expect(lastSignIn(h).details).toEqual({ mfa: false, newDevice: true });
    expect(newDeviceEvents(h)).toEqual([expect.objectContaining({ userId: ALICE, ip: '203.0.113.7', deviceLabel: 'Firefox on Windows', details: { sessionId: sessionOf(firefox) } })]);
    expect(alerts(h)).toEqual([
      expect.objectContaining({
        aggregateType: 'USER',
        aggregateId: ALICE,
        eventType: 'security.new_device_login.v1',
        payload: { eventId: expect.any(String), eventType: 'security.new_device_login.v1', timestamp: expect.any(String), userId: ALICE, email: 'alice@example.com', deviceLabel: 'Firefox on Windows', ipMasked: '203.0.113.x', at: expect.any(String) },
      }),
    ]);

    // The same browser from another network: new device
    await signIn(h, { ip: '198.51.100.7', userAgent: CHROME_WINDOWS });
    expect(newDeviceEvents(h)).toHaveLength(2);
    expect(alerts(h).at(-1)!.payload).toEqual(expect.objectContaining({ deviceLabel: 'Chrome on Windows', ipMasked: '198.51.100.x' }));

    // IPv6: the network is the /48, so another /64 of the same site is still the same network
    await signIn(h, PHONE);
    expect(newDeviceEvents(h)).toHaveLength(3);
    await signIn(h, { ip: '2001:db8:1:ffff::9', userAgent: SAFARI_IPHONE });
    expect(newDeviceEvents(h)).toHaveLength(3);

    // Known for 90 days after it was last used, not a day longer
    const chromeAtHome = () => h.prisma.tables.userSession.filter((s) => s.browser === 'Chrome' && s.network === '203.0.113.x');
    chromeAtHome().forEach((s) => (s.lastSeenAt = new Date(Date.now() - (KNOWN_DEVICE_DAYS - 1) * DAY)));
    await signIn(h, DESKTOP);
    expect(newDeviceEvents(h)).toHaveLength(3);
    chromeAtHome().forEach((s) => (s.lastSeenAt = new Date(Date.now() - (KNOWN_DEVICE_DAYS + 1) * DAY)));
    await signIn(h, DESKTOP);
    expect(newDeviceEvents(h)).toHaveLength(4);
    expect(alerts(h)).toHaveLength(4);
  });

  it('an unknown browser is still a device: two unlabelled clients from one network count as the same one', async () => {
    const h = build();
    await signIn(h, { ip: '203.0.113.7' });
    await signIn(h, { ip: '203.0.113.7', userAgent: 'curl/8.4.0' });
    expect(newDeviceEvents(h)).toHaveLength(0);
    const sessions = await request(h.app).get('/api/v1/auth/sessions').set(bearer(tokensOf(await signIn(h, { ip: '203.0.113.7' })).accessToken));
    expect(sessions.body.data.map((s: { deviceLabel: string }) => s.deviceLabel)).toEqual(['Unknown device', 'Unknown device', 'Unknown device']);
  });
});
