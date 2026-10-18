import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { AuthController } from '../controllers/auth.controller';

export interface AuthRateLimiters {
  /** login / register: per client IP */
  credentials: RequestHandler;
  /** refresh / logout: per client IP */
  refresh: RequestHandler;
  /** forgot-password / resend-verification / reset / verify: per client IP */
  recovery: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function createAuthRouter(
  controller: AuthController,
  authenticate: RequestHandler,
  limiters: AuthRateLimiters = { credentials: passThrough, refresh: passThrough, recovery: passThrough }
): Router {
  const router = Router();

  router.post('/register', limiters.credentials, controller.register);
  router.post('/login', limiters.credentials, controller.login);
  router.post('/refresh', limiters.refresh, controller.refresh);
  router.post('/logout', limiters.refresh, controller.logout);

  router.post('/email/verify', limiters.recovery, controller.verifyEmail);
  router.post('/email/resend-verification', limiters.recovery, controller.resendVerification);
  router.post('/password/forgot', limiters.recovery, controller.forgotPassword);
  router.post('/password/reset', limiters.recovery, controller.resetPassword);
  router.post('/password/change', limiters.credentials, authenticate, controller.changePassword);

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
