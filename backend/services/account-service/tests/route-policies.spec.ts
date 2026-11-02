import { RequestHandler } from 'express';
import request from 'supertest';
import {
  InMemoryTokenStateStore,
  assertRoutePolicies,
  generateJwtKeyPair,
  signAccessToken,
  stubController,
  UserRole,
  ROLES,
} from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.LEDGER_INTERNAL_TOKEN = 'l'.repeat(40);
process.env.CUSTOMER_INTERNAL_TOKEN = 'c'.repeat(40);

import { createApp } from '../src/app';
import { createAccountRouter } from '../src/routes/account.routes';
import { ACCOUNT_ACCESS } from '../src/routes/access';
import { AccountController } from '../src/controllers/account.controller';

const passThrough: RequestHandler = (_req, _res, next) => next();
const tokenFor = (role: UserRole) =>
  signAccessToken({ sub: `${role.toLowerCase()}-user`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: role !== 'CUSTOMER', sessionId: `s-${role}` });

describe('account-service route policies', () => {
  it('every /api/v1/accounts route has exactly the roles declared in src/routes/access.ts', () => {
    const router = createAccountRouter(stubController<AccountController>(), passThrough);
    expect(() => assertRoutePolicies(router, ACCOUNT_ACCESS, 'account router')).not.toThrow();
  });

  it('routes open to every role are owner-or-staff routes and say what the service enforces', () => {
    for (const rule of ACCOUNT_ACCESS.filter((r) => r.roles !== 'public' && r.roles.length === ROLES.length)) {
      expect([rule.method, rule.path, rule.note]).toEqual([rule.method, rule.path, expect.stringMatching(/Enforced in AccountService/)]);
    }
  });

  it('the declared policies are what the running app enforces: no token is 401, customers are refused staff lookups', async () => {
    const prisma: any = { bankAccount: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) }, staffAccessLog: { create: jest.fn() } };
    const { app } = createApp(prisma, {
      tokenState: new InMemoryTokenStateStore(),
      ledgerClient: {} as any,
      customerClient: {} as any,
    });
    for (const rule of ACCOUNT_ACCESS) {
      const url = `/api/v1/accounts${rule.path.replace(/:[A-Za-z]+/g, '11111111-1111-4111-8111-111111111111').replace(/\/$/, '')}`;
      const method = rule.method.toLowerCase() as 'get' | 'post' | 'patch';
      expect([rule.method, rule.path, (await request(app)[method](url).send({})).status]).toEqual([rule.method, rule.path, 401]);
    }
    const lookup = '/api/v1/accounts/lookup?accountNumber=200000000006';
    expect((await request(app).get(lookup).set('Authorization', `Bearer ${tokenFor('CUSTOMER')}`)).status).toBe(403);
    expect((await request(app).get(lookup).set('Authorization', `Bearer ${tokenFor('TELLER')}`)).status).toBe(404);
  });
});
