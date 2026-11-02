import express, { RequestHandler, Router } from 'express';
import request from 'supertest';
import {
  INTERNAL_TOKEN_HEADER,
  InMemoryTokenStateStore,
  assertRoutePolicies,
  describeRoutes,
  errorHandlerMiddleware,
  generateJwtKeyPair,
  stubController,
} from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
const LEDGER_TOKEN = 'l'.repeat(40);
const PAYMENT_TOKEN = 'p'.repeat(40);
process.env.LEDGER_INTERNAL_TOKEN = LEDGER_TOKEN;
process.env.PAYMENT_LEDGER_INTERNAL_TOKEN = PAYMENT_TOKEN;

import { createApp } from '../src/app';
import { createTransactionRouter } from '../src/routes/transaction.routes';
import { createInternalRouter } from '../src/routes/internal.routes';
import { createPaymentInternalRouter } from '../src/routes/payment-internal.routes';
import { INTERNAL_ACCESS, TRANSACTION_ACCESS } from '../src/routes/access';
import { TransactionController } from '../src/controllers/transaction.controller';

const passThrough: RequestHandler = (_req, _res, next) => next();
const ID = '11111111-1111-4111-8111-111111111111';
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, ID);

describe('transaction-service route policies', () => {
  it('every /api/v1/transactions route has exactly the roles declared in src/routes/access.ts', () => {
    const router = createTransactionRouter(stubController<TransactionController>(), passThrough);
    expect(() => assertRoutePolicies(router, TRANSACTION_ACCESS, 'transaction router')).not.toThrow();
  });

  it('the check has teeth: an unguarded route, or a loosened one, fails it', () => {
    const extra = createTransactionRouter(stubController<TransactionController>(), passThrough);
    extra.get('/new-thing', passThrough);
    expect(() => assertRoutePolicies(extra, TRANSACTION_ACCESS)).toThrow(/GET \/new-thing: no authorization policy/);

    const loosened = TRANSACTION_ACCESS.map((rule) => (rule.path === '/audit/verify' ? { ...rule, roles: ['BANK_ADMIN', 'SUPPORT'] as const } : rule));
    expect(() => assertRoutePolicies(createTransactionRouter(stubController<TransactionController>(), passThrough), loosened)).toThrow(
      /GET \/audit\/verify: code allows BANK_ADMIN, access table says SUPPORT,BANK_ADMIN/
    );
  });

  it('owner-or-staff routes say so in the access table', () => {
    for (const rule of TRANSACTION_ACCESS.filter((r) => r.path.startsWith('/accounts/'))) {
      expect(rule.note).toMatch(/Owner of a customer account, or any staff role/);
    }
  });
});

describe('internal routers: guarded by a credential, not a role', () => {
  const routers: Record<string, () => Router> = {
    '/internal/v1/payments': () => createPaymentInternalRouter({} as any),
    '/internal/v1': () => createInternalRouter({} as any),
  };

  it.each(INTERNAL_ACCESS.map((t) => [t.prefix, t] as const))('%s: the routes are exactly the declared ones, all after the guard', (_prefix, table) => {
    const router = routers[table.prefix]();
    const stack = (router as any).stack as Array<{ route?: unknown }>;
    expect(stack[0].route).toBeUndefined(); // requireInternalService, registered before any route
    expect(stack.findIndex((layer) => layer.route)).toBeGreaterThan(0);
    expect(describeRoutes(router).map((r) => ({ method: r.method, path: r.path }))).toEqual(table.routes);
  });

  it.each(INTERNAL_ACCESS.map((t) => [t.prefix, t] as const))('%s: every route answers 401 without its own credential', async (_prefix, table) => {
    const app = express();
    app.use(express.json());
    app.use(table.prefix, routers[table.prefix]());
    app.use(errorHandlerMiddleware);
    const otherToken = table.credential === 'PAYMENT_LEDGER_INTERNAL_TOKEN' ? LEDGER_TOKEN : PAYMENT_TOKEN;
    for (const route of table.routes) {
      const url = `${table.prefix}${concrete(route.path)}`;
      const method = route.method.toLowerCase() as 'get' | 'post' | 'patch';
      const none = await request(app)[method](url).send({});
      const other = await request(app)[method](url).set(INTERNAL_TOKEN_HEADER, otherToken).send({});
      expect([route.method, route.path, none.status, other.status]).toEqual([route.method, route.path, 401, 401]);
    }
  });

  it('LEAST PRIVILEGE in the assembled app: each caller reaches only its own internal API', async () => {
    const prisma: any = {
      ledgerAccount: { findUnique: jest.fn().mockResolvedValue(null) },
      transaction: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const { app } = createApp(prisma, { tokenState: new InMemoryTokenStateStore() });

    // payment-service's credential: its own routes only
    const account = await request(app).get(`/internal/v1/payments/accounts/${ID}`).set(INTERNAL_TOKEN_HEADER, PAYMENT_TOKEN);
    expect(account.status).toBe(404); // reached the payments API (no such account)
    for (const [method, url] of [
      ['get', `/internal/v1/ledger-accounts/${ID}`],
      ['post', '/internal/v1/ledger-accounts'],
      ['post', `/internal/v1/ledger-accounts/${ID}/close`],
      ['patch', `/internal/v1/ledger-accounts/${ID}`],
    ] as const) {
      expect([url, (await request(app)[method](url).set(INTERNAL_TOKEN_HEADER, PAYMENT_TOKEN).send({})).status]).toEqual([url, 401]);
    }
    // An unknown payments path stops at the payments router instead of falling through
    expect((await request(app).get('/internal/v1/payments/ledger-accounts').set(INTERNAL_TOKEN_HEADER, PAYMENT_TOKEN)).status).toBe(404);

    // account-service's credential can't post top-ups or refunds
    for (const url of ['/internal/v1/payments/credits', '/internal/v1/payments/refunds', `/internal/v1/payments/refunds/${ID}/reverse`]) {
      expect([url, (await request(app).post(url).set(INTERNAL_TOKEN_HEADER, LEDGER_TOKEN).send({})).status]).toEqual([url, 401]);
    }
    expect((await request(app).get(`/internal/v1/ledger-accounts/${ID}`).set(INTERNAL_TOKEN_HEADER, LEDGER_TOKEN)).status).toBe(404);
  });

  it('refuses to start without the payments credential', () => {
    const saved = process.env.PAYMENT_LEDGER_INTERNAL_TOKEN;
    delete process.env.PAYMENT_LEDGER_INTERNAL_TOKEN;
    try {
      expect(() => createApp({} as any, { tokenState: new InMemoryTokenStateStore() })).toThrow('PAYMENT_LEDGER_INTERNAL_TOKEN');
    } finally {
      process.env.PAYMENT_LEDGER_INTERNAL_TOKEN = saved;
    }
  });
});
