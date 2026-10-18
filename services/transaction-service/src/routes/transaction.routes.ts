import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { TransactionController } from '../controllers/transaction.controller';

export function createTransactionRouter(controller: TransactionController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // Financial write endpoints requiring Idempotency-Key
  router.post('/transfer', controller.transfer);
  router.post('/withdraw', controller.withdraw);
  // Deposits create money in the ledger: teller (BANK_ADMIN) only
  router.post('/deposit', requireRoles('BANK_ADMIN'), controller.deposit);

  // Read-only ledger queries (owner or staff)
  router.get('/accounts/:accountId/balance', controller.getBalance);
  router.get('/accounts/:accountId/history', controller.getHistory);

  return router;
}
