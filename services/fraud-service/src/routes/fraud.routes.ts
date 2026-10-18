import { Router } from 'express';
import { authenticate, requireRoles } from '@banksphere/common';
import { FraudController } from '../controllers/fraud.controller';

export function createFraudRouter(controller: FraudController): Router {
  const router = Router();

  // Risk data is compliance-only
  router.use(authenticate, requireRoles('BANK_ADMIN', 'SUPPORT'));

  router.post('/evaluate', controller.evaluate);
  router.get('/alerts', controller.getAlerts);
  router.patch('/alerts/:alertId', controller.updateAlert);

  return router;
}
