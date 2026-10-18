import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { TransactionController } from '../controllers/transaction.controller';

export function createTransactionRouter(controller: TransactionController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // Customer money movement (owner of the source account only); requires Idempotency-Key
  router.post('/transfer', requireRoles('CUSTOMER'), controller.transfer);

  // Teller cash operations: BANK_ADMIN only, never on their own accounts, maker-checker above limits
  router.post('/deposit', requireRoles('BANK_ADMIN'), controller.deposit);
  router.post('/withdraw', requireRoles('BANK_ADMIN'), controller.withdraw);
  router.get('/cash-operations', requireRoles('BANK_ADMIN', 'SUPPORT'), controller.listCashOperations);
  router.post('/cash-operations/:cashOperationId/approve', requireRoles('BANK_ADMIN'), controller.approveCashOperation);
  router.post('/cash-operations/:cashOperationId/reject', requireRoles('BANK_ADMIN'), controller.rejectCashOperation);

  // Read-only ledger queries (owner or staff)
  router.get('/accounts/:accountId/balance', controller.getBalance);
  router.get('/accounts/:accountId/history', controller.getHistory);

  return router;
}
