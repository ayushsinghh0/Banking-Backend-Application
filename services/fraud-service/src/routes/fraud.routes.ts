import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { FraudController } from '../controllers/fraud.controller';

export function createFraudRouter(controller: FraudController, authenticate: RequestHandler): Router {
  const router = Router();

  // Risk data is compliance-only; triage is for fraud analysts (and supervisors)
  router.use(authenticate, requireRoles('FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'));

  router.post('/evaluate', requireRoles('FRAUD_ANALYST'), controller.evaluate);
  router.get('/alerts', controller.getAlerts);
  router.patch('/alerts/:alertId', requireRoles('FRAUD_ANALYST', 'BANK_ADMIN'), controller.updateAlert);
  router.get('/alerts/:alertId/history', controller.getAlertHistory);

  return router;
}
