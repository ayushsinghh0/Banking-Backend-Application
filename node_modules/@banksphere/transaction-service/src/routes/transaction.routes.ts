import { Router } from 'express';
import { TransactionController } from '../controllers/transaction.controller';

export function createTransactionRouter(controller: TransactionController): Router {
  const router = Router();

  // Financial write endpoints requiring Idempotency-Key
  router.post('/transfer', controller.transfer);
  router.post('/deposit', controller.deposit);
  router.post('/withdraw', controller.withdraw);

  // Read-only ledger queries
  router.get('/accounts/:accountId/balance', controller.getBalance);
  router.get('/accounts/:accountId/history', controller.getHistory);

  return router;
}
