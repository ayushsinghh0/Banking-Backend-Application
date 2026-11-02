import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { NotFoundError, requireInternalService } from '@banksphere/common';
import { PaymentLedgerService, PaymentPostingResult } from '../services/payment-ledger.service';

/** Credential of the payments ledger API: payment-service only, separate from LEDGER_INTERNAL_TOKEN */
export const PAYMENT_LEDGER_TOKEN_ENV = 'PAYMENT_LEDGER_INTERNAL_TOKEN';

const uuid = z.string().uuid();
// Positive whole paise, at most 18 digits (far inside BIGINT and the balance ceiling's arithmetic)
const amountPaise = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, { message: 'amountPaise must be a positive whole number of paise, as a string' })
  .transform((value) => BigInt(value));

const creditSchema = z
  .object({
    topUpId: uuid,
    accountId: uuid,
    customerId: uuid,
    amountPaise,
    providerPaymentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { message: 'providerPaymentId must be the provider payment id' }),
  })
  .strict();

const refundSchema = z
  .object({
    refundId: uuid,
    topUpId: uuid,
    accountId: uuid,
    customerId: uuid,
    amountPaise,
  })
  .strict();

const accountParams = z.object({ accountId: uuid }).strict();
const refundParams = z.object({ refundId: uuid }).strict();
const emptyBody = z.object({}).strict();

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** 201 for a new posting, 200 for a replay of an existing one (same body shape) */
function sendPosting(res: Response, result: PaymentPostingResult): void {
  res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
}

/**
 * Ledger API for payment-service (design section 6, "Ledger internal API for payments"). Mounted at
 * /internal/v1/payments, never routed by the gateway, and guarded by its own credential: payment-service
 * can read a customer account's state and post top-up credits, refunds and refund reversals, nothing else
 * (it cannot provision, update or close accounts, which need LEDGER_INTERNAL_TOKEN).
 */
export function createPaymentInternalRouter(paymentLedger: PaymentLedgerService): Router {
  const router = Router();
  router.use(requireInternalService(PAYMENT_LEDGER_TOKEN_ENV));

  router.get(
    '/accounts/:accountId',
    wrap(async (req, res) => {
      const { accountId } = accountParams.parse(req.params);
      res.json({ success: true, data: await paymentLedger.getAccount(accountId) });
    })
  );

  router.post(
    '/credits',
    wrap(async (req, res) => {
      sendPosting(res, await paymentLedger.credit(creditSchema.parse(req.body)));
    })
  );

  router.post(
    '/refunds',
    wrap(async (req, res) => {
      sendPosting(res, await paymentLedger.refund(refundSchema.parse(req.body)));
    })
  );

  router.post(
    '/refunds/:refundId/reverse',
    wrap(async (req, res) => {
      const { refundId } = refundParams.parse(req.params);
      emptyBody.parse(req.body ?? {});
      sendPosting(res, await paymentLedger.reverseRefund(refundId));
    })
  );

  // Terminal: an unknown payments path ends here (after the credential check) instead of falling through to
  // the account-lifecycle router mounted at /internal/v1
  router.use((_req: Request, _res: Response, next: NextFunction) => next(new NotFoundError('Not found')));

  return router;
}
