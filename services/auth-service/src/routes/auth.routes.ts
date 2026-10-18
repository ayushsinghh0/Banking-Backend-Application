import { RequestHandler, Router } from 'express';
import { authenticate, requireRoles } from '@banksphere/common';
import { AuthController } from '../controllers/auth.controller';

export interface AuthRateLimiters {
  credentials: RequestHandler;
  refresh: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function createAuthRouter(
  controller: AuthController,
  limiters: AuthRateLimiters = { credentials: passThrough, refresh: passThrough }
): Router {
  const router = Router();

  router.post('/register', limiters.credentials, controller.register);
  router.post('/login', limiters.credentials, controller.login);
  router.post('/refresh', limiters.refresh, controller.refresh);
  router.post('/logout', limiters.refresh, controller.logout);

  router.get('/me', authenticate, controller.me);

  // Staff provisioning: the only way to obtain BANK_ADMIN / SUPPORT roles
  router.post('/admin/users', authenticate, requireRoles('BANK_ADMIN'), controller.createStaffUser);
  router.patch(
    '/admin/users/:userId/status',
    authenticate,
    requireRoles('BANK_ADMIN'),
    controller.setUserStatus
  );

  return router;
}
