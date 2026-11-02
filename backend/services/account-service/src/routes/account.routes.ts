import { RequestHandler, Router } from 'express';
import { anyAuthenticated, requireRoles } from '@banksphere/common';
import { AccountController } from '../controllers/account.controller';

// Every route carries exactly one explicit policy; src/routes/access.ts declares them and
// tests/route-policies.spec.ts proves the two agree. Staff may hold personal accounts, on which they have
// exactly a customer's rights, so the per-account rules (owner or staff, admin powers on other people's
// accounts only) are decided in AccountService, not by role here.
export function createAccountRouter(controller: AccountController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  router.post('/', anyAuthenticated('opens an account for the caller; requires VERIFIED KYC (customer-service)'), controller.create);
  router.get('/', anyAuthenticated("the caller's own accounts; staff: any customer's with ?customerId= (access-logged)"), controller.list);
  // Before '/:accountId', which would otherwise capture it
  router.get('/lookup', requireRoles('TELLER', 'SUPPORT', 'BANK_ADMIN', 'KYC_OFFICER', 'FRAUD_ANALYST'), controller.lookup);
  router.get('/:accountId', anyAuthenticated('owner or staff (access-logged); enforced in AccountService'), controller.getById);
  router.patch(
    '/:accountId/status',
    anyAuthenticated("owner may freeze; BANK_ADMIN may freeze, unfreeze (dual control) or close other people's accounts; enforced in AccountService"),
    controller.updateStatus
  );
  router.patch(
    '/:accountId/daily-limit',
    anyAuthenticated("owner within the customer cap and bank ceiling; BANK_ADMIN on other people's accounts; enforced in AccountService"),
    controller.updateDailyLimit
  );

  return router;
}
