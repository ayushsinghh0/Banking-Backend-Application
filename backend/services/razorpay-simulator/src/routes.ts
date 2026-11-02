import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { RazorpayErrors } from './errors';
import { paymentSignature } from './signatures';
import { SimPayment, SimulatorStore } from './store';
import { WebhookDispatcher } from './webhooks';

const RAZORPAY_ID = /^[A-Za-z0-9_]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

// Razorpay's own limits: amounts are whole paise from INR 1.00, receipts up to 40 characters, at most
// 15 notes of up to 256 characters each
const amount = z.number().int('amount must be a whole number of paise').min(100, 'Order amount less than minimum amount allowed');
const notes = z
  .record(z.string().min(1).max(256), z.string().max(256))
  .refine((value) => Object.keys(value).length <= 15, 'notes may hold at most 15 keys');

const createOrderSchema = z.object({
  amount,
  currency: z.string().regex(CURRENCY, 'currency must be a 3-letter code').default('INR'),
  receipt: z.string().max(40).nullish(),
  notes: notes.optional(),
});
const captureSchema = z.object({ amount: z.number().int().positive(), currency: z.string().regex(CURRENCY) });
const refundSchema = z.object({
  amount: z.number().int().positive().optional(),
  speed: z.enum(['normal', 'optimum']).optional(),
  receipt: z.string().max(40).nullish(),
  notes: notes.optional(),
});
const checkoutSchema = z.object({ outcome: z.enum(['success', 'authorized', 'failure']), method: z.enum(['upi', 'card', 'netbanking']) });

function id(req: Request, name: string): string {
  const value = req.params[name];
  if (!value || !RAZORPAY_ID.test(value)) throw RazorpayErrors.notFound();
  return value;
}

const collection = <T>(items: T[]) => ({ entity: 'collection', count: items.length, items });

type Handler = (req: Request, res: Response) => void;
const handle =
  (fn: Handler): RequestHandler =>
  (req, res, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      next(error);
    }
  };

/** Announces a captured payment the way Razorpay does: the payment, then the order it completed */
function announceCapture(webhooks: WebhookDispatcher, store: SimulatorStore, payment: SimPayment): void {
  webhooks.send('payment.captured', { payment: { entity: payment } });
  webhooks.send('order.paid', { order: { entity: store.getOrder(payment.order_id) }, payment: { entity: payment } });
}

/** The subset of Razorpay's REST API that payment-service uses, mounted at /v1 */
export function createRazorpayRouter(store: SimulatorStore, webhooks: WebhookDispatcher, auth: RequestHandler): Router {
  const router = Router();
  router.use(auth);

  router.post(
    '/orders',
    handle((req, res) => {
      const input = createOrderSchema.parse(req.body);
      res.json(store.createOrder(input));
    })
  );
  router.get('/orders/:id', handle((req, res) => res.json(store.getOrder(id(req, 'id')))));
  router.get('/orders/:id/payments', handle((req, res) => res.json(collection(store.paymentsOf(id(req, 'id'))))));

  router.get('/payments/:id', handle((req, res) => res.json(store.getPayment(id(req, 'id')))));
  router.post(
    '/payments/:id/capture',
    handle((req, res) => {
      const input = captureSchema.parse(req.body);
      const payment = store.capture(id(req, 'id'), input.amount, input.currency);
      announceCapture(webhooks, store, payment);
      res.json(payment);
    })
  );
  router.post(
    '/payments/:id/refund',
    handle((req, res) => {
      const input = refundSchema.parse(req.body ?? {});
      const refund = store.refund(id(req, 'id'), input);
      webhooks.send('refund.processed', { refund: { entity: refund }, payment: { entity: store.getPayment(refund.payment_id) } });
      res.json(refund);
    })
  );
  router.get('/payments/:id/refunds', handle((req, res) => res.json(collection(store.refundsOf(id(req, 'id'))))));
  router.get('/refunds/:id', handle((req, res) => res.json(store.getRefund(id(req, 'id')))));

  return router;
}

/**
 * What a browser running Checkout.js would do, as one call (mounted at /sim): pays the order with the
 * requested outcome, hands back the signed triple the Checkout handler receives, and sends the webhooks
 * Razorpay would. Same credentials as the API: only the merchant's backend may "pay" its orders.
 */
export function createSimRouter(store: SimulatorStore, webhooks: WebhookDispatcher, auth: RequestHandler, keySecret: string): Router {
  const router = Router();
  router.use(auth);

  router.post(
    '/checkout/:orderId',
    handle((req, res) => {
      const input = checkoutSchema.parse(req.body);
      const payment = store.checkout(id(req, 'orderId'), input.outcome, input.method);
      if (payment.status === 'captured') announceCapture(webhooks, store, payment);
      else if (payment.status === 'authorized') webhooks.send('payment.authorized', { payment: { entity: payment } });
      else webhooks.send('payment.failed', { payment: { entity: payment } });
      res.json({
        razorpay_order_id: payment.order_id,
        razorpay_payment_id: payment.id,
        razorpay_signature: paymentSignature(payment.order_id, payment.id, keySecret),
      });
    })
  );

  return router;
}
