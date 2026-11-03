import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireInternalService } from '@banksphere/common';
import { LedgerService } from '../services/ledger.service';

const paise = z
  .string()
  .regex(/^\d{1,18}$/)
  .transform((v) => BigInt(v));

const provisionSchema = z
  .object({
    id: z.string().uuid(),
    accountNumber: z.string().regex(/^\d{12}$/),
    customerId: z.string().uuid(),
    currency: z.literal('INR'),
    dailyLimitPaise: paise,
    isActive: z.boolean(),
  })
  .strict();

const updateSchema = z
  .object({
    isActive: z.boolean().optional(),
    dailyLimitPaise: paise.optional(),
    version: z.number().int().positive(),
  })
  .strict();
const closeSchema = z.object({ version: z.number().int().positive() }).strict();

const idParams = z.object({ accountId: z.string().uuid() });
const snapshotsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict();

/**
 * Service-to-service API used by account-service to keep the ledger in sync with account lifecycle.
 * Not routed through the public gateway, and additionally protected by INTERNAL_SERVICE_TOKEN.
 */
export function createInternalRouter(ledgerService: LedgerService): Router {
  const router = Router();
  router.use(requireInternalService('LEDGER_INTERNAL_TOKEN'));

  router.post('/ledger-accounts', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = provisionSchema.parse(req.body);
      await ledgerService.provisionAccount(dto);
      res.status(201).json({ success: true, data: await ledgerService.getAccountSnapshot(dto.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ledger-accounts/snapshots', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ids } = snapshotsSchema.parse(req.body);
      res.json({ success: true, data: await ledgerService.getAccountSnapshots(ids) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ledger-accounts/:accountId/close', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId } = idParams.parse(req.params);
      const { version } = closeSchema.parse(req.body);
      await ledgerService.closeAccount(accountId, version);
      res.json({ success: true, data: await ledgerService.getAccountSnapshot(accountId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ledger-accounts/:accountId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId } = idParams.parse(req.params);
      res.json({ success: true, data: await ledgerService.getAccountSnapshot(accountId) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/ledger-accounts/:accountId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId } = idParams.parse(req.params);
      const dto = updateSchema.parse(req.body);
      const { applied } = await ledgerService.updateAccount(accountId, dto);
      res.json({ success: true, data: { applied, ...(await ledgerService.getAccountSnapshot(accountId)) } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
