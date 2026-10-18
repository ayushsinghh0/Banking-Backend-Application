import { Request, Response, NextFunction, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { requireInternalService, requireRoles } from '@banksphere/common';
import { CustomerController } from '../controllers/customer.controller';
import { CustomerService } from '../services/customer.service';

export function createCustomerRouter(controller: CustomerController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  // Profile endpoints
  router.get('/me', controller.getMe);
  router.post('/me', controller.createMe);
  router.patch('/me', controller.updateMe);

  // Staff endpoints: profile lookup and KYC review
  router.get('/:userId', requireRoles('BANK_ADMIN', 'SUPPORT'), controller.getByUserId);
  router.patch('/:userId/kyc', requireRoles('BANK_ADMIN'), controller.updateKycStatus);

  return router;
}

const userIdParams = z.object({ userId: z.string().uuid() });

/**
 * Service-to-service API (not routed by the gateway): lets account-service check KYC before opening accounts.
 */
export function createInternalCustomerRouter(customerService: CustomerService): Router {
  const router = Router();
  router.use(requireInternalService);

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
