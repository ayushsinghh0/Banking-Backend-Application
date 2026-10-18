import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller';

export function createCustomerRouter(controller: CustomerController): Router {
  const router = Router();

  // Profile endpoints
  router.get('/me', controller.getMe);
  router.post('/me', controller.createMe);
  router.patch('/me', controller.updateMe);

  return router;
}
