import { RequestHandler } from 'express';
import request from 'supertest';
import { InMemoryTokenStateStore, assertRoutePolicies, generateJwtKeyPair, signAccessToken, stubController, ROLES, UserRole } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;

import { createApp } from '../src/app';
import { createFraudRouter } from '../src/routes/fraud.routes';
import { FRAUD_ACCESS, INTERNAL_ACCESS } from '../src/routes/access';
import { FraudController } from '../src/controllers/fraud.controller';

const passThrough: RequestHandler = (_req, _res, next) => next();
const ID = '6f1c3d52-8a3e-4f0a-9d0c-2b7e5c1a9f10';
const concrete = (path: string) => `/api/v1/fraud${path.replace(/:[A-Za-z]+/g, ID)}`;
const tokenFor = (role: UserRole) =>
  signAccessToken({ sub: `${role.toLowerCase()}-user`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: role !== 'CUSTOMER', sessionId: `s-${role}` });

describe('fraud-service route policies', () => {
  it('every /api/v1/fraud route has exactly the roles declared in src/routes/access.ts', () => {
    const router = createFraudRouter(stubController<FraudController>(), passThrough);
    expect(() => assertRoutePolicies(router, FRAUD_ACCESS, 'fraud router')).not.toThrow();
  });

  it('the check has teeth: an undeclared route, or a loosened one, fails it', () => {
    // The router-wide guard still covers a route added later, but it must be declared before it ships
    const extra = createFraudRouter(stubController<FraudController>(), passThrough);
    extra.get('/stats', passThrough);
    expect(() => assertRoutePolicies(extra, FRAUD_ACCESS)).toThrow(/GET \/stats: not in the access table \(roles in code: SUPPORT,FRAUD_ANALYST,BANK_ADMIN\)/);

    const loosened = FRAUD_ACCESS.map((rule) => (rule.path === '/alerts/:alertId' ? { ...rule, roles: ['FRAUD_ANALYST', 'BANK_ADMIN'] as const } : rule));
    expect(() => assertRoutePolicies(createFraudRouter(stubController<FraudController>(), passThrough), loosened)).toThrow(
      /PATCH \/alerts\/:alertId: code allows FRAUD_ANALYST, access table says FRAUD_ANALYST,BANK_ADMIN/
    );
  });

  it('risk data is compliance-only: nothing for customers, tellers or KYC officers; writes are the analysts’ alone', () => {
    for (const rule of FRAUD_ACCESS) {
      expect(rule.roles).not.toBe('public');
      for (const role of ['CUSTOMER', 'TELLER', 'KYC_OFFICER'] as const) expect([rule.method, rule.path, rule.roles]).not.toContain(role);
    }
    for (const rule of FRAUD_ACCESS.filter((r) => r.method !== 'GET')) expect([rule.method, rule.path, rule.roles]).toEqual([rule.method, rule.path, ['FRAUD_ANALYST']]);
    expect(INTERNAL_ACCESS).toEqual([]);
  });

  it('the declared policies are what the running app enforces, for every route and every role', async () => {
    const prisma: any = {
      fraudAlert: { findMany: jest.fn().mockResolvedValue([]) },
      fraudAlertEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { app } = createApp(prisma, { tokenState: new InMemoryTokenStateStore() });
    for (const rule of FRAUD_ACCESS) {
      const method = rule.method.toLowerCase() as 'get' | 'post' | 'patch';
      expect([rule.method, rule.path, (await request(app)[method](concrete(rule.path)).send({})).status]).toEqual([rule.method, rule.path, 401]);
      for (const role of ROLES) {
        const status = (await request(app)[method](concrete(rule.path)).set('Authorization', `Bearer ${tokenFor(role)}`).send({})).status;
        // An allowed role reaches the handler (200, or 400 for the empty body); a refused one is a 403 before it
        const outcome = status === 403 ? 'forbidden' : status === 401 ? 'unauthenticated' : 'allowed';
        const expected = rule.roles !== 'public' && rule.roles.includes(role) ? 'allowed' : 'forbidden';
        expect([rule.method, rule.path, role, outcome]).toEqual([rule.method, rule.path, role, expected]);
      }
    }
  });
});
