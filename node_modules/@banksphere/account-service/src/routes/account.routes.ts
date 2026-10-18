import { Router } from 'express';
import { AccountController } from '../controllers/account.controller';

export function createAccountRouter(controller: AccountController): Router {
  const router = Router();

  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:accountId', controller.getById);
  router.patch('/:accountId/status', controller.updateStatus);

  return router;
}
