import { RequestHandler, Router } from 'express';
import { requireRoles } from '@banksphere/common';
import { AuthController } from '../controllers/auth.controller';

export interface AuthRateLimiters {
  /** login / register / change-password: per client IP */
  credentials: RequestHandler;
  /** refresh / logout: per client IP */
  refresh: RequestHandler;
  /** forgot-password / resend-verification / reset / verify / MFA login: per client IP */
  recovery: RequestHandler;
}

export interface AuthMiddleware {
  /** Standard authentication: staff must have an MFA-authenticated session */
  authenticate: RequestHandler;
  /** Lets staff without MFA through, used only for MFA enrolment and self-inspection */
  authenticateForEnrolment: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function createAuthRouter(
  controller: AuthController,
  auth: AuthMiddleware,
  limiters: AuthRateLimiters = { credentials: passThrough, refresh: passThrough, recovery: passThrough }
): Router {
  const router = Router();

  router.post('/register', limiters.credentials, controller.register);
  router.post('/login', limiters.credentials, controller.login);
  router.post('/login/mfa', limiters.recovery, controller.loginMfa);
  router.post('/refresh', limiters.refresh, controller.refresh);
  router.post('/logout', limiters.refresh, controller.logout);

  router.post('/email/verify', limiters.recovery, controller.verifyEmail);
  router.post('/email/resend-verification', limiters.recovery, controller.resendVerification);
  router.post('/password/forgot', limiters.recovery, controller.forgotPassword);
  router.post('/password/reset', limiters.recovery, controller.resetPassword);
  router.post('/password/change', limiters.credentials, auth.authenticate, controller.changePassword);

  router.get('/me', auth.authenticateForEnrolment, controller.me);
  router.post('/mfa/setup', limiters.credentials, auth.authenticateForEnrolment, controller.mfaSetup);
  router.post('/mfa/enable', limiters.credentials, auth.authenticateForEnrolment, controller.mfaEnable);
  router.post('/mfa/disable', limiters.credentials, auth.authenticate, controller.mfaDisable);
  router.post('/mfa/step-up', limiters.credentials, auth.authenticate, controller.mfaStepUp);
  router.post('/staff/activate', limiters.recovery, controller.activateStaff);

  // Staff administration (BANK_ADMIN with an MFA session). Staff changes are four-eyes requests.
  const admin = [auth.authenticate, requireRoles('BANK_ADMIN')];
  router.post('/admin/users', ...admin, controller.createStaffUser);
  router.patch('/admin/users/:userId/status', ...admin, controller.setUserStatus);
  router.post('/admin/users/:userId/mfa/reset', ...admin, controller.resetUserMfa);
  router.get('/admin/requests', ...admin, controller.listAdminRequests);
  router.post('/admin/requests/:requestId/approve', ...admin, controller.approveAdminRequest);
  router.post('/admin/requests/:requestId/reject', ...admin, controller.rejectAdminRequest);

  return router;
}
