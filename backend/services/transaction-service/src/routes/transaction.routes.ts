import { RequestHandler, Router } from 'express';
import { anyAuthenticated, authorize, requireRoles } from '@banksphere/common';
import { TransactionController } from '../controllers/transaction.controller';

// Every route carries exactly one explicit policy; src/routes/access.ts declares them and
// tests/route-policies.spec.ts proves the two agree.

export function createTransactionRouter(controller: TransactionController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // Customer: transfers (owner of the source only; Idempotency-Key), payees, withdrawal codes
  router.post('/transfer', requireRoles('CUSTOMER'), controller.transfer);
  router.get('/beneficiaries', requireRoles('CUSTOMER'), controller.listBeneficiaries);
  router.post('/beneficiaries', requireRoles('CUSTOMER'), controller.addBeneficiary);
  router.delete('/beneficiaries/:id', requireRoles('CUSTOMER'), controller.removeBeneficiary);
  router.post('/withdrawal-codes', requireRoles('CUSTOMER'), controller.createWithdrawalCode);

  // Teller (maker): branch cash, inside a business-day session, never on their own accounts.
  // Literal /teller/sessions/* paths stay above the parameterised /teller/sessions/:id routes.
  router.get('/teller/sessions/current', requireRoles('TELLER'), controller.currentSession);
  router.post('/teller/sessions/accept', requireRoles('TELLER'), controller.acceptFloat);
  router.post('/teller/sessions/close', requireRoles('TELLER'), controller.closeSession);
  router.post('/deposit', requireRoles('TELLER'), controller.deposit);
  router.post('/withdraw', requireRoles('TELLER'), controller.withdraw);

  // Supervisor (checker): approvals and session sign-off
  router.get('/teller/sessions', requireRoles('BANK_ADMIN', 'SUPPORT'), controller.listSessions);
  router.post('/teller/sessions', requireRoles('BANK_ADMIN'), controller.issueFloat);
  router.post('/teller/sessions/:id/cancel', requireRoles('BANK_ADMIN'), controller.cancelFloat);
  router.post('/teller/sessions/:id/sign-off', requireRoles('BANK_ADMIN'), controller.signOffSession);
  router.get('/cash-operations', requireRoles('TELLER', 'BANK_ADMIN', 'SUPPORT'), controller.listCashOperations); // tellers: their own
  router.post('/cash-operations/:cashOperationId/approve', requireRoles('BANK_ADMIN'), controller.approveCashOperation);
  router.post('/cash-operations/:cashOperationId/reject', requireRoles('BANK_ADMIN'), controller.rejectCashOperation);

  // Integrity: re-walks the tamper-evident audit chain
  router.get('/audit/verify', authorize('audit:verify'), controller.verifyAuditChain);

  // Read-only ledger queries: every role may ask, the service answers only the owner or staff (staff reads
  // are audit-logged) and shows cash and clearing accounts to BANK_ADMIN only
  const ownerOrStaff = anyAuthenticated('owner of the account or staff (audit-logged); cash and clearing accounts BANK_ADMIN only; enforced in LedgerService');
  router.get('/accounts/:accountId/balance', ownerOrStaff, controller.getBalance);
  router.get('/accounts/:accountId/history', ownerOrStaff, controller.getHistory);

  return router;
}
