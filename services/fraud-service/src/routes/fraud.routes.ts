import { Router } from 'express';
import { FraudController } from '../controllers/fraud.controller';

export function createFraudRouter(controller: FraudController): Router {
  const router = Router();

  router.post('/evaluate', controller.evaluate);
  router.get('/alerts', controller.getAlerts);

  return router;
}
