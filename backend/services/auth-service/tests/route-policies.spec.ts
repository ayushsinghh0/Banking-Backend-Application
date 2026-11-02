import crypto from 'crypto';
import { RequestHandler } from 'express';
import request from 'supertest';
import {
  ConsoleMailer,
  InMemoryTokenStateStore,
  ROLES,
  UserRole,
  assertRoutePolicies,
  generateJwtKeyPair,
  signAccessToken,
  stubController,
} from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { createApp } from '../src/app';
import { createAuthRouter } from '../src/routes/auth.routes';
import { AUTH_ACCESS } from '../src/routes/access';
import { AuthController } from '../src/controllers/auth.controller';
import { SecurityController } from '../src/controllers/security.controller';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { InMemoryEdgeSecurityStore } from '../src/services/edge-security.store';
import { FakePrisma } from './support/fake-prisma';

const passThrough: RequestHandler = (_req, _res, next) => next();

/** The account-security routes added in design section 9 (the older routes are covered in auth.service.spec.ts) */
const SECURITY_ROUTES = [
  'GET /sessions',
  'DELETE /sessions/:sessionId',
  'POST /sessions/revoke-others',
  'GET /security-events',
  'GET /admin/users/:userId/sessions',
  'DELETE /admin/users/:userId/sessions/:sessionId',
  'GET /admin/security-events',
  'GET /admin/ip-rules',
  'POST /admin/ip-rules',
  'DELETE /admin/ip-rules/:ruleId',
  'GET /admin/ip-bans',
  'DELETE /admin/ip-bans/:ipKey',
  'GET /admin/audit/verify',
];

// Fixture ids: the customer whose sessions staff look at, one session per role for the own-session routes
const TARGET_USER = '11111111-1111-4111-8111-111111111111';
const TARGET_SESSION = '22222222-2222-4222-8222-222222222222';
const RULE_ID = '33333333-3333-4333-8333-333333333333';
const BANNED_IP = '203.0.113.9';
const SESSION_OF = Object.fromEntries(ROLES.map((role) => [role, crypto.randomUUID()])) as Record<UserRole, string>;
const userOf = (role: UserRole) => `${role.toLowerCase()}-user`;

const tokenFor = (role: UserRole, mfa = role !== 'CUSTOMER') =>
  signAccessToken({ sub: userOf(role), email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa, sessionId: SESSION_OF[role] });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A fresh app with the rows every route needs to answer 2xx when the caller is allowed */
async function freshApp() {
  const prisma = new FakePrisma();
  const edge = new InMemoryEdgeSecurityStore();
  const { app } = createApp(prisma as unknown as PrismaClient, {
    tokenState: new InMemoryTokenStateStore(),
    security: new InMemoryAuthSecurityStore(),
    mailer: new ConsoleMailer(),
    edge,
  });
  const inADay = new Date(Date.now() + 86_400_000);
  prisma.seed('user', [{ id: TARGET_USER, email: 'target@example.com', passwordHash: 'unused' }]);
  prisma.seed('userSession', [
    { id: TARGET_SESSION, userId: TARGET_USER, expiresAt: inADay, deviceLabel: 'Chrome on Windows', browser: 'Chrome', os: 'Windows' },
    ...ROLES.map((role) => ({ id: SESSION_OF[role], userId: userOf(role), expiresAt: inADay, deviceLabel: 'Firefox on Linux', browser: 'Firefox', os: 'Linux' })),
  ]);
  prisma.seed('ipRule', [{ id: RULE_ID, cidr: '203.0.113.0/24', reason: 'Scanning the sign-in page', createdBy: userOf('BANK_ADMIN') }]);
  await edge.banIp(BANNED_IP, 1800, { reason: 'CREDENTIAL_STUFFING', bannedAt: new Date().toISOString(), source: 'auth-service' });
  return app;
}

function urlFor(path: string, role: UserRole): string {
  const own = !path.startsWith('/admin');
  return `/api/v1/auth${path
    .replace(':sessionId', own ? SESSION_OF[role] : TARGET_SESSION)
    .replace(':userId', TARGET_USER)
    .replace(':ruleId', RULE_ID)
    .replace(':ipKey', BANNED_IP)}`;
}

const NEW_RULE = { cidr: '198.51.100.0/24', reason: 'Scanning our sign-in page', expiresInMinutes: 60 };

describe('auth-service route policies', () => {
  it('every /api/v1/auth route has exactly the roles declared in src/routes/access.ts', () => {
    const router = createAuthRouter(stubController<AuthController>(), stubController<SecurityController>(), {
      authenticate: passThrough,
      authenticateForEnrolment: passThrough,
    });
    expect(() => assertRoutePolicies(router, AUTH_ACCESS, 'auth router')).not.toThrow();
  });

  it('declares every account-security route of the design, and no admin route is open to every role', () => {
    const declared = AUTH_ACCESS.map((rule) => `${rule.method} ${rule.path}`);
    for (const route of SECURITY_ROUTES) expect(declared).toContain(route);
    for (const rule of AUTH_ACCESS.filter((r) => r.path.startsWith('/admin'))) {
      expect([rule.path, rule.roles]).not.toEqual([rule.path, 'public']);
      expect(rule.roles.length).toBeLessThan(ROLES.length);
    }
    // Routes open to every signed-in role say how the service scopes them to the caller
    for (const rule of AUTH_ACCESS.filter((r) => r.roles !== 'public' && r.roles.length === ROLES.length)) {
      expect([rule.path, rule.note]).toEqual([rule.path, expect.stringMatching(/own/)]);
    }
  });

  it('every non-public route answers 401 without a token', async () => {
    const app = await freshApp();
    for (const rule of AUTH_ACCESS.filter((r) => r.roles !== 'public')) {
      const method = rule.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
      const res = await request(app)[method](urlFor(rule.path, 'CUSTOMER')).send({});
      expect([rule.method, rule.path, res.status]).toEqual([rule.method, rule.path, 401]);
    }
  });

  it('the account-security routes let exactly the declared roles through (2xx) and refuse the others (403)', async () => {
    const rules = AUTH_ACCESS.filter((rule) => SECURITY_ROUTES.includes(`${rule.method} ${rule.path}`));
    expect(rules).toHaveLength(SECURITY_ROUTES.length);
    for (const rule of rules) {
      for (const role of ROLES) {
        // A fresh fixture per call: a DELETE that succeeded would otherwise turn the next role's attempt into a 404
        const app = await freshApp();
        const method = rule.method.toLowerCase() as 'get' | 'post' | 'delete';
        const res = await request(app)[method](urlFor(rule.path, role)).set(bearer(tokenFor(role))).send(rule.method === 'POST' && rule.path === '/admin/ip-rules' ? NEW_RULE : {});
        const allowed = rule.roles !== 'public' && rule.roles.includes(role);
        const outcome = res.status >= 200 && res.status < 300 ? '2xx' : res.status;
        expect([rule.method, rule.path, role, outcome]).toEqual([rule.method, rule.path, role, allowed ? '2xx' : 403]);
        if (!allowed) expect(res.body.error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('staff without an MFA session are refused everywhere, before any permission check', async () => {
    const app = await freshApp();
    for (const [method, path] of [
      ['get', '/admin/security-events'],
      ['get', '/admin/ip-rules'],
      ['get', '/sessions'],
    ] as const) {
      const res = await request(app)[method](`/api/v1/auth${path}`).set(bearer(tokenFor('BANK_ADMIN', false)));
      expect([path, res.status, res.body.error.code]).toEqual([path, 403, 'MFA_REQUIRED']);
    }
    // Customers have no second factor requirement
    expect((await request(app).get('/api/v1/auth/sessions').set(bearer(tokenFor('CUSTOMER', false)))).status).toBe(200);
  });

  it('a stray token gets no more than the role it carries: SUPPORT reads sessions but cannot end them or write rules', async () => {
    const app = await freshApp();
    const support = bearer(tokenFor('SUPPORT'));
    expect((await request(app).get(`/api/v1/auth/admin/users/${TARGET_USER}/sessions`).set(support)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/auth/admin/users/${TARGET_USER}/sessions/${TARGET_SESSION}`).set(support)).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/admin/ip-rules').set(support).send(NEW_RULE)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/auth/admin/ip-bans/${BANNED_IP}`).set(support)).status).toBe(403);
    expect((await request(app).get('/api/v1/auth/admin/audit/verify').set(support)).status).toBe(403);
  });
});
