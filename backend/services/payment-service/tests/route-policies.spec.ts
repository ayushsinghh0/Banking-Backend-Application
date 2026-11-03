/**
 * Every payment-service route carries an explicit authorization policy that matches the declared access table
 * (src/routes/access.ts), and the running app enforces it: adding a route or loosening one fails the build.
 */
import './support/env';
import { RequestHandler } from 'express';
import request from 'supertest';
import { assertRoutePolicies, describeRoutes, stubController } from '@banksphere/common';
import { PAYMENT_ROUTES_ACCESS, WEBHOOK_ROUTES_ACCESS } from '../src/routes/access';
import { createPaymentRouter, createWebhookRouter } from '../src/routes/payment.routes';
import { PaymentController, WebhookController } from '../src/controllers/payment.controller';
import { PAYMENTS_PREFIX } from '../src/app';
import { bearer, buildHarness, users } from './support/harness';

const passThrough: RequestHandler = (_req, _res, next) => next();
const ID = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';
const concrete = (path: string) => `${PAYMENTS_PREFIX}${path.replace(/:[A-Za-z]+/g, ID)}`;

describe('payment-service route policies', () => {
  it('match the access tables exactly', () => {
    expect(() => assertRoutePolicies(createPaymentRouter(stubController<PaymentController>(), passThrough), PAYMENT_ROUTES_ACCESS, 'payment router')).not.toThrow();
    expect(() => assertRoutePolicies(createWebhookRouter(stubController<WebhookController>()), WEBHOOK_ROUTES_ACCESS, 'webhook router')).not.toThrow();
  });

  it('the check has teeth: an unguarded route, or a loosened one, fails it', () => {
    const extra = createPaymentRouter(stubController<PaymentController>(), passThrough);
    extra.get('/export', passThrough);
    expect(() => assertRoutePolicies(extra, PAYMENT_ROUTES_ACCESS)).toThrow(/GET \/export: no authorization policy/);
    const loosened = PAYMENT_ROUTES_ACCESS.map((r) => (r.path === '/admin/top-ups/:id/refund' ? { ...r, roles: ['BANK_ADMIN', 'SUPPORT'] as const } : r));
    expect(() => assertRoutePolicies(createPaymentRouter(stubController<PaymentController>(), passThrough), loosened)).toThrow(/admin\/top-ups\/:id\/refund/);
  });

  it('only the webhook is public, and it is authorized by its signature', () => {
    const [webhook] = describeRoutes(createWebhookRouter(stubController<WebhookController>()));
    expect(webhook.policies).toEqual([expect.objectContaining({ kind: 'public', note: expect.stringMatching(/HMAC-SHA256/) })]);
    expect(PAYMENT_ROUTES_ACCESS.every((r) => r.roles !== 'public')).toBe(true);
  });

  it('money moves only for customers (top-ups) and BANK_ADMIN (refunds, reconciliation)', () => {
    for (const rule of PAYMENT_ROUTES_ACCESS.filter((r) => r.method === 'POST')) {
      expect([rule.path, rule.roles]).toEqual([rule.path, rule.path.startsWith('/admin/') ? ['BANK_ADMIN'] : ['CUSTOMER']]);
    }
  });

  it('the running app enforces the table: no token is 401, and roles outside a rule are 403', async () => {
    const h = buildHarness();
    const everyone = Object.values(users).filter((u, i, all) => all.findIndex((v) => v.role === u.role) === i);
    for (const rule of PAYMENT_ROUTES_ACCESS) {
      if (rule.roles === 'public') continue;
      const method = rule.method.toLowerCase() as 'get' | 'post';
      expect([rule.method, rule.path, (await request(h.app)[method](concrete(rule.path)).send({})).status]).toEqual([rule.method, rule.path, 401]);
      for (const user of everyone.filter((u) => !(rule.roles as readonly string[]).includes(u.role))) {
        const res = await request(h.app)[method](concrete(rule.path)).set('authorization', bearer(user)).send({});
        expect([rule.method, rule.path, user.role, res.status]).toEqual([rule.method, rule.path, user.role, 403]);
      }
    }
  });
});
