import { Router } from 'express';
import { authenticate, requireRoles } from '@banksphere/common';
import { CustomerController } from '../controllers/customer.controller';

export function createCustomerRouter(controller: CustomerController): Router {
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
