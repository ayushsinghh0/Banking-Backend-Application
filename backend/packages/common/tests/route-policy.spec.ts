import express, { RequestHandler, Router } from 'express';
import request from 'supertest';
import {
  AccessRule,
  anyAuthenticated,
  assertRoutePolicies,
  authorize,
  can,
  describeRoutes,
  publicRoute,
  requireRoles,
  rolesWith,
  ROLE_PERMISSIONS,
  stubController,
} from '../src';
import { ROLES } from '../src/auth/jwt';

const authenticate: RequestHandler = (_req, _res, next) => next();

describe('describeRoutes', () => {
  it('combines router-level and route-level policies and intersects their roles', () => {
    const router = Router();
    router.use(authenticate, requireRoles('FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'));
    router.get('/alerts', (_req, res) => res.end());
    router.patch('/alerts/:id', requireRoles('FRAUD_ANALYST'), (_req, res) => res.end());

    const routes = describeRoutes(router);

    expect(routes).toEqual([
      expect.objectContaining({ method: 'GET', path: '/alerts', effective: ['SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] }),
      expect.objectContaining({ method: 'PATCH', path: '/alerts/:id', effective: ['FRAUD_ANALYST'] }),
    ]);
  });

  it('reports routes without any policy, and only counts policies registered before the route', () => {
    const router = Router();
    router.use(authenticate);
    router.get('/open', (_req, res) => res.end());
    router.use(requireRoles('BANK_ADMIN'));
    router.get('/admin', (_req, res) => res.end());

    const [open, admin] = describeRoutes(router);
    expect(open.effective).toBe('none');
    expect(admin.effective).toEqual(['BANK_ADMIN']);
  });

  it('describes public, any-authenticated and permission routes', () => {
    const router = Router();
    router.post('/webhook', publicRoute('signed by the provider'), (_req, res) => res.end());
    router.get('/me', anyAuthenticated('own data only'), (_req, res) => res.end());
    router.post('/refund', authorize('payments:refund'), (_req, res) => res.end());

    const [webhook, me, refund] = describeRoutes(router);
    expect(webhook.effective).toBe('public');
    expect(me.effective).toEqual([...ROLES]);
    expect(refund.effective).toEqual(['BANK_ADMIN']);
  });

  it('refuses nested routers instead of describing them wrongly', () => {
    const router = Router();
    router.use('/sub', Router());
    expect(() => describeRoutes(router)).toThrow(/nested routers/);
  });
});

describe('assertRoutePolicies', () => {
  const build = () => {
    const controller = stubController<{ list: RequestHandler; refund: RequestHandler }>();
    const router = Router();
    router.use(authenticate);
    router.get('/top-ups', authorize('payments:read:own', 'payments:read:any'), controller.list);
    router.post('/top-ups/:id/refund', authorize('payments:refund'), controller.refund);
    return router;
  };
  const table: AccessRule[] = [
    { method: 'GET', path: '/top-ups', roles: ['CUSTOMER', 'SUPPORT', 'FRAUD_ANALYST', 'BANK_ADMIN'] },
    { method: 'POST', path: '/top-ups/:id/refund', roles: ['BANK_ADMIN'] },
  ];

  it('passes when the router matches the declared table exactly', () => {
    expect(() => assertRoutePolicies(build(), table)).not.toThrow();
  });

  it('lists every difference: wider roles, undeclared routes and stale table rows', () => {
    const router = build();
    router.delete('/top-ups/:id', authorize('payments:topup'), (_req, res) => res.end());
    const stale: AccessRule[] = [
      { method: 'GET', path: '/top-ups', roles: ['CUSTOMER'] },
      { method: 'POST', path: '/top-ups/:id/refund', roles: ['BANK_ADMIN'] },
      { method: 'GET', path: '/gone', roles: ['BANK_ADMIN'] },
    ];

    let message = '';
    try {
      assertRoutePolicies(router, stale, 'payments');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('GET /top-ups: code allows CUSTOMER,SUPPORT,FRAUD_ANALYST,BANK_ADMIN, access table says CUSTOMER');
    expect(message).toContain('DELETE /top-ups/:id: not in the access table');
    expect(message).toContain('GET /gone: in the access table but not in the payments');
  });

  it('requires a reason for public routes', () => {
    const router = Router();
    router.post('/hook', publicRoute('signed'), (_req, res) => res.end());
    expect(() => assertRoutePolicies(router, [{ method: 'POST', path: '/hook', roles: 'public' }])).toThrow(/need a note/);
  });
});

describe('permissions', () => {
  it('maps permissions to roles from one table', () => {
    expect(rolesWith('payments:refund')).toEqual(['BANK_ADMIN']);
    expect(rolesWith('assistant:chat')).toEqual([...ROLES]);
    expect(can({ role: 'CUSTOMER' }, 'payments:topup')).toBe(true);
    expect(can({ role: 'TELLER' }, 'payments:topup')).toBe(false);
    expect(can(undefined, 'assistant:chat')).toBe(false);
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role]).toContain('security:sessions:own');
  });

  it('authorize answers 401 without a user, 403 without the permission, and passes with any of them', async () => {
    const app = express();
    app.use((req, _res, next) => {
      const role = req.header('x-role');
      if (role) req.user = { id: 'u1', email: 'u@bank.test', role: role as never };
      next();
    });
    app.get('/x', authorize('payments:read:own', 'payments:read:any'), (_req, res) => res.json({ ok: true }));
    app.use(((err, _req, res, _next) => res.status(err.statusCode).json({ code: err.errorCode })) as express.ErrorRequestHandler);

    await request(app).get('/x').expect(401);
    await request(app).get('/x').set('x-role', 'TELLER').expect(403, { code: 'FORBIDDEN' });
    await request(app).get('/x').set('x-role', 'CUSTOMER').expect(200);
    await request(app).get('/x').set('x-role', 'SUPPORT').expect(200);
  });

  it('refuses to build an authorization check without permissions or roles', () => {
    expect(() => authorize()).toThrow();
    expect(() => requireRoles()).toThrow();
  });
});
