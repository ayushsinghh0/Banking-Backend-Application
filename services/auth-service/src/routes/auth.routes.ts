import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);

  return router;
}
