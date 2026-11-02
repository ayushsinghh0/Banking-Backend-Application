import { RequestHandler } from 'express';
import request from 'supertest';
import {
  INTERNAL_TOKEN_HEADER,
  InMemoryTokenStateStore,
  assertRoutePolicies,
  describeRoutes,
  generateJwtKeyPair,
  signAccessToken,
  stubController,
  ROLES,
  UserRole,
} from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
const CUSTOMER_TOKEN = 'c'.repeat(40);
process.env.CUSTOMER_INTERNAL_TOKEN = CUSTOMER_TOKEN;

import { createApp } from '../src/app';
import { createCustomerRouter, createInternalCustomerRouter } from '../src/routes/customer.routes';
import { CUSTOMER_ACCESS, INTERNAL_ACCESS } from '../src/routes/access';
import { CustomerController } from '../src/controllers/customer.controller';

const passThrough: RequestHandler = (_req, _res, next) => next();
const ID = '11111111-1111-4111-8111-111111111111';
const concrete = (path: string) => `/api/v1/customers${path.replace(/:[A-Za-z]+/g, ID)}`.replace(/\/$/, '');
const tokenFor = (role: UserRole) =>
  signAccessToken({ sub: `${role.toLowerCase()}-user`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: role !== 'CUSTOMER', sessionId: `s-${role}` });

const prismaStub = (): any => ({
  customerProfile: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  kycEvent: { findMany: jest.fn().mockResolvedValue([]) },
  staffAccessLog: { create: jest.fn(), createMany: jest.fn() },
});

describe('customer-service route policies', () => {
  it('every /api/v1/customers route has exactly the roles declared in src/routes/access.ts', () => {
    const router = createCustomerRouter(stubController<CustomerController>(), passThrough);
    expect(() => assertRoutePolicies(router, CUSTOMER_ACCESS, 'customer router')).not.toThrow();
  });

  it('the check has teeth: an unguarded route, or a loosened one, fails it', () => {
    const extra = createCustomerRouter(stubController<CustomerController>(), passThrough);
    extra.get('/export', passThrough);
    expect(() => assertRoutePolicies(extra, CUSTOMER_ACCESS)).toThrow(/GET \/export: no authorization policy/);

    const loosened = CUSTOMER_ACCESS.map((rule) => (rule.path === '/:userId/kyc' ? { ...rule, roles: ['KYC_OFFICER', 'BANK_ADMIN'] as const } : rule));
    expect(() => assertRoutePolicies(createCustomerRouter(stubController<CustomerController>(), passThrough), loosened)).toThrow(
      /PATCH \/:userId\/kyc: code allows KYC_OFFICER, access table says KYC_OFFICER,BANK_ADMIN/
    );
  });

  it("the routes open to every role are the caller's own profile, and say what the service enforces", () => {
    const open = CUSTOMER_ACCESS.filter((r) => r.roles !== 'public' && r.roles.length === ROLES.length);
    expect(open.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /me', 'PATCH /me', 'POST /me']);
    for (const rule of open) expect(rule.note).toMatch(/Enforced in CustomerService/);
  });

  it('KYC decisions are the KYC officers’ alone (separation of duties); nothing is public', () => {
    expect(CUSTOMER_ACCESS.find((r) => r.method === 'PATCH' && r.path === '/:userId/kyc')?.roles).toEqual(['KYC_OFFICER']);
    expect(CUSTOMER_ACCESS.every((r) => r.roles !== 'public')).toBe(true);
  });

  it('the declared policies are what the running app enforces: no token is 401, customers are refused every staff route', async () => {
    const { app } = createApp(prismaStub(), { tokenState: new InMemoryTokenStateStore() });
    for (const rule of CUSTOMER_ACCESS) {
      const method = rule.method.toLowerCase() as 'get' | 'post' | 'patch';
      expect([rule.method, rule.path, (await request(app)[method](concrete(rule.path)).send({})).status]).toEqual([rule.method, rule.path, 401]);
    }
    const asCustomer = `Bearer ${tokenFor('CUSTOMER')}`;
    for (const rule of CUSTOMER_ACCESS.filter((r) => r.roles !== 'public' && !r.roles.includes('CUSTOMER'))) {
      const method = rule.method.toLowerCase() as 'get' | 'post' | 'patch';
      const res = await request(app)[method](concrete(rule.path)).set('Authorization', asCustomer).send({});
      expect([rule.method, rule.path, res.status]).toEqual([rule.method, rule.path, 403]);
    }
    // The caller's own profile: authorized by identity alone, then a 404 because none exists yet
    expect((await request(app).get('/api/v1/customers/me').set('Authorization', asCustomer)).status).toBe(404);
    // A KYC decision by an administrator is refused by role, before the service sees it
    const decision = await request(app)
      .patch(`/api/v1/customers/${ID}/kyc`)
      .set('Authorization', `Bearer ${tokenFor('BANK_ADMIN')}`)
      .send({ kycStatus: 'VERIFIED', expectedVersion: 1 });
    expect(decision.status).toBe(403);
  });
});

describe('internal router: guarded by a credential, not a role', () => {
  it.each(INTERNAL_ACCESS.map((t) => [t.prefix, t] as const))('%s: the routes are exactly the declared ones, all after the guard', (_prefix, table) => {
    const router = createInternalCustomerRouter({} as any);
    const stack = (router as any).stack as Array<{ route?: unknown }>;
    expect(stack[0].route).toBeUndefined(); // requireInternalService, registered before any route
    expect(stack.findIndex((layer) => layer.route)).toBeGreaterThan(0);
    expect(describeRoutes(router).map((r) => ({ method: r.method, path: r.path }))).toEqual(table.routes);
  });

  it('answers 401 without its credential (a staff JWT is not one) and serves account-service with it', async () => {
    const { app } = createApp(prismaStub(), { tokenState: new InMemoryTokenStateStore() });
    const url = `/internal/v1/customers/${ID}/kyc`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set(INTERNAL_TOKEN_HEADER, 'x'.repeat(40))).status).toBe(401);
    expect((await request(app).get(url).set('Authorization', `Bearer ${tokenFor('BANK_ADMIN')}`)).status).toBe(401);

    const ok = await request(app).get(url).set(INTERNAL_TOKEN_HEADER, CUSTOMER_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, data: { userId: ID, kycStatus: 'PENDING' } });
  });

  it('refuses to start without the credential', () => {
    const saved = process.env.CUSTOMER_INTERNAL_TOKEN;
    delete process.env.CUSTOMER_INTERNAL_TOKEN;
    try {
      expect(() => createApp({} as any, { tokenState: new InMemoryTokenStateStore() })).toThrow('CUSTOMER_INTERNAL_TOKEN');
    } finally {
      process.env.CUSTOMER_INTERNAL_TOKEN = saved;
    }
  });
});
