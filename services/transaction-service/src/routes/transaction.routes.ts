import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { TransactionController } from '../controllers/transaction.controller';

export function createTransactionRouter(controller: TransactionController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // Customer: transfers (owner of the source only; Idempotency-Key), payees, withdrawal codes
  router.post('/transfer', requireRoles('CUSTOMER'), controller.transfer);
  router.get('/beneficiaries', requireRoles('CUSTOMER'), controller.listBeneficiaries);
  router.post('/beneficiaries', requireRoles('CUSTOMER'), controller.addBeneficiary);
  router.delete('/beneficiaries/:id', requireRoles('CUSTOMER'), controller.removeBeneficiary);
  router.post('/withdrawal-codes', requireRoles('CUSTOMER'), controller.createWithdrawalCode);

  // Teller (maker): branch cash, inside a business-day session, never on their own accounts
  router.post('/teller/sessions/accept', requireRoles('TELLER'), controller.acceptFloat);
  router.post('/teller/sessions/close', requireRoles('TELLER'), controller.closeSession);
  router.post('/deposit', requireRoles('TELLER'), controller.deposit);
  router.post('/withdraw', requireRoles('TELLER'), controller.withdraw);

  // Supervisor (checker): approvals and session sign-off
  router.get('/teller/sessions', requireRoles('BANK_ADMIN', 'SUPPORT'), controller.listSessions);
  router.post('/teller/sessions', requireRoles('BANK_ADMIN'), controller.issueFloat);
  router.post('/teller/sessions/:id/cancel', requireRoles('BANK_ADMIN'), controller.cancelFloat);
  router.post('/teller/sessions/:id/sign-off', requireRoles('BANK_ADMIN'), controller.signOffSession);
  router.get('/cash-operations', requireRoles('TELLER', 'BANK_ADMIN', 'SUPPORT'), controller.listCashOperations);
  router.post('/cash-operations/:cashOperationId/approve', requireRoles('BANK_ADMIN'), controller.approveCashOperation);
  router.post('/cash-operations/:cashOperationId/reject', requireRoles('BANK_ADMIN'), controller.rejectCashOperation);

  // Read-only ledger queries (owner or staff; staff reads are audit-logged)
  router.get('/accounts/:accountId/balance', controller.getBalance);
  router.get('/accounts/:accountId/history', controller.getHistory);

  return router;
}
