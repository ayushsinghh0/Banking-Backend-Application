import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { FraudController } from '../controllers/fraud.controller';

export function createFraudRouter(controller: FraudController, authenticate: RequestHandler): Router {
  const router = Router();

  // Risk data is compliance-only (analysts, supervisors and support may read it)
  router.use(authenticate, requireRoles('FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'));

  router.post('/evaluate', requireRoles('FRAUD_ANALYST'), controller.evaluate);
  router.get('/alerts', controller.getAlerts);
  // Triage is the fraud analysts' job only: administrators (who also approve cash operations) must not be
  // able to close alerts, including about operations they approved
  router.patch('/alerts/:alertId', requireRoles('FRAUD_ANALYST'), controller.updateAlert);
  router.get('/alerts/:alertId/history', controller.getAlertHistory);

  return router;
}
