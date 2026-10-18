import { RequestHandler, Router } from 'express';
import { AccountController } from '../controllers/account.controller';

export function createAccountRouter(controller: AccountController, authenticate: RequestHandler): Router {
  const router = Router();

  router.use(authenticate);

  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:accountId', controller.getById);
  router.patch('/:accountId/status', controller.updateStatus);
  router.patch('/:accountId/daily-limit', controller.updateDailyLimit);

  return router;
}
