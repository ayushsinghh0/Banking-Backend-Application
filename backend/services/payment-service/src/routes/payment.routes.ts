import { RequestHandler, Router } from 'express';
import { authorize, publicRoute } from '@banksphere/common';
import { PaymentController, WebhookController } from '../controllers/payment.controller';

/** Mounted at /api/v1/payments. Every route names its permission; ownership is enforced again in the services. */
export function createPaymentRouter(controller: PaymentController, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate);

  // Customer: own top-ups
  router.get('/config', authorize('payments:topup'), controller.config);
  router.post('/top-ups', authorize('payments:topup'), controller.createTopUp);
  router.get('/top-ups', authorize('payments:read:own'), controller.list);
  router.get('/top-ups/:id', authorize('payments:read:own', 'payments:read:any'), controller.get);
  router.post('/top-ups/:id/confirm', authorize('payments:topup'), controller.confirm);
  router.post('/top-ups/:id/cancel', authorize('payments:topup'), controller.cancel);
  router.post('/top-ups/:id/simulate', authorize('payments:topup'), controller.simulate);

  // Staff
  router.get('/admin/top-ups', authorize('payments:read:any'), controller.adminList);
  router.get('/admin/summary', authorize('payments:read:any'), controller.summary);
  router.post('/admin/top-ups/:id/refund', authorize('payments:refund'), controller.refund);
  router.post('/admin/reconcile', authorize('payments:reconcile'), controller.reconcile);

  return router;
}

/** Mounted at /api/v1/payments ahead of the authenticated router: Razorpay can't send a bearer token */
export function createWebhookRouter(controller: WebhookController): Router {
  const router = Router();
  router.post(
    '/webhooks/razorpay',
    publicRoute('Razorpay webhook: authenticated by HMAC-SHA256 of the raw body with the webhook secret (plus the optional source allowlist)'),
    controller.razorpay
  );
  return router;
}
