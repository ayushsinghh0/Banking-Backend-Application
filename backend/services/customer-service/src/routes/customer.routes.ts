import { Request, Response, NextFunction, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { anyAuthenticated, requireInternalService, requireRoles } from '@banksphere/common';
import { CustomerController } from '../controllers/customer.controller';
import { CustomerService } from '../services/customer.service';

export function createCustomerRouter(controller: CustomerController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // The caller's own profile: the service only ever reads or writes the token subject's profile here
  const own = anyAuthenticated("the caller's own profile only; enforced in CustomerService");
  router.get('/me', own, controller.getMe);
  router.post('/me', own, controller.createMe);
  router.patch('/me', own, controller.updateMe);

  // Staff endpoints: profile search and lookup (logged) and KYC review (KYC officers only: separation of duties).
  // '/' matches only the bare path, so it can't capture '/me' or '/:userId'.
  router.get('/', requireRoles('KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'), controller.list);
  const staff = requireRoles('SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN');
  router.get('/:userId', staff, controller.getByUserId);
  router.patch('/:userId/kyc', requireRoles('KYC_OFFICER'), controller.updateKycStatus);
  router.get('/:userId/kyc/history', requireRoles('KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'), controller.getKycHistory);

  return router;
}

const userIdParams = z.object({ userId: z.string().uuid() });

/**
 * Service-to-service API (not routed by the gateway): lets account-service check KYC before opening accounts.
 */
export function createInternalCustomerRouter(customerService: CustomerService): Router {
  const router = Router();
  router.use(requireInternalService('CUSTOMER_INTERNAL_TOKEN'));

  router.get('/customers/:userId/kyc', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = userIdParams.parse(req.params);
      const kycStatus = await customerService.getKycStatus(userId);
      res.json({ success: true, data: { userId, kycStatus } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
