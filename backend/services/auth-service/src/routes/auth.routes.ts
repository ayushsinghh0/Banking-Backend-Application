import { RequestHandler, Router } from 'express';
import { anyAuthenticated, authorize, publicRoute, requireRoles } from '@banksphere/common';
import { AuthController } from '../controllers/auth.controller';
import { SecurityController } from '../controllers/security.controller';

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

/**
 * Every route carries exactly one explicit authorization decision (design section 4), checked against
 * src/routes/access.ts by tests/route-policies.spec.ts: public routes say why, routes open to every signed-in
 * role say how the service scopes them to the caller, everything else names roles or permissions.
 */
export function createAuthRouter(
  controller: AuthController,
  security: SecurityController,
  auth: AuthMiddleware,
  limiters: AuthRateLimiters = { credentials: passThrough, refresh: passThrough, recovery: passThrough }
): Router {
  const router = Router();
  const own = (note: string) => anyAuthenticated(note);

  // Credentials and recovery: these establish identity, so nobody is signed in yet
  router.post('/register', publicRoute('self-registration; always creates an unverified CUSTOMER'), limiters.credentials, controller.register);
  router.post('/login', publicRoute('password sign-in'), limiters.credentials, controller.login);
  router.post('/login/mfa', publicRoute('second sign-in step, proven by the challenge token'), limiters.recovery, controller.loginMfa);
  router.post('/refresh', publicRoute('session continuation, proven by the refresh token'), limiters.refresh, controller.refresh);
  router.post('/logout', publicRoute('ends the session of the refresh token presented'), limiters.refresh, controller.logout);
  router.post('/email/verify', publicRoute('proven by the emailed one-time token'), limiters.recovery, controller.verifyEmail);
  router.post('/email/resend-verification', publicRoute('same answer for every address'), limiters.recovery, controller.resendVerification);
  router.post('/password/forgot', publicRoute('same answer for every address'), limiters.recovery, controller.forgotPassword);
  router.post('/password/reset', publicRoute('proven by the emailed one-time token'), limiters.recovery, controller.resetPassword);
  router.post('/staff/activate', publicRoute('proven by the emailed one-time activation token'), limiters.recovery, controller.activateStaff);

  // The caller's own account (every operation is scoped to the token's user by the service)
  router.post('/password/change', limiters.credentials, auth.authenticate, own('own password; re-authenticates'), controller.changePassword);
  router.get('/me', auth.authenticateForEnrolment, own('own profile'), controller.me);
  router.post('/mfa/setup', limiters.credentials, auth.authenticateForEnrolment, own('own second factor; re-authenticates'), controller.mfaSetup);
  router.post('/mfa/enable', limiters.credentials, auth.authenticateForEnrolment, own('own second factor'), controller.mfaEnable);
  router.post('/mfa/disable', limiters.credentials, auth.authenticate, own('own second factor; staff refused by the service'), controller.mfaDisable);
  router.post('/mfa/step-up', limiters.credentials, auth.authenticate, own('own session'), controller.mfaStepUp);

  // Sessions and sign-in history (own)
  router.get('/sessions', auth.authenticate, authorize('security:sessions:own'), security.listSessions);
  router.delete('/sessions/:sessionId', auth.authenticate, authorize('security:sessions:own'), security.revokeSession);
  router.post('/sessions/revoke-others', auth.authenticate, authorize('security:sessions:own'), security.revokeOtherSessions);
  router.get('/security-events', auth.authenticate, authorize('security:sessions:own'), security.listSecurityEvents);

  // Staff administration (BANK_ADMIN with an MFA session). Staff changes are four-eyes requests.
  const admin = [auth.authenticate, requireRoles('BANK_ADMIN')];
  // Read-only user directory: also for SUPPORT
  router.get('/admin/users', auth.authenticate, requireRoles('BANK_ADMIN', 'SUPPORT'), controller.listUsers);
  router.post('/admin/users', ...admin, controller.createStaffUser);
  router.patch('/admin/users/:userId/status', ...admin, controller.setUserStatus);
  router.post('/admin/users/:userId/mfa/reset', ...admin, controller.resetUserMfa);
  router.get('/admin/requests', ...admin, controller.listAdminRequests);
  router.post('/admin/requests/:requestId/approve', ...admin, controller.approveAdminRequest);
  router.post('/admin/requests/:requestId/reject', ...admin, controller.rejectAdminRequest);

  // Account security administration (permissions, design section 4)
  router.get('/admin/users/:userId/sessions', auth.authenticate, authorize('security:sessions:read:any'), security.adminListSessions);
  router.delete('/admin/users/:userId/sessions/:sessionId', auth.authenticate, authorize('security:sessions:revoke:any'), security.adminRevokeSession);
  router.get('/admin/security-events', auth.authenticate, authorize('security:events:read:any'), security.adminListSecurityEvents);
  router.get('/admin/ip-rules', auth.authenticate, authorize('security:ip-rules:read'), security.listIpRules);
  router.post('/admin/ip-rules', auth.authenticate, authorize('security:ip-rules:write'), security.createIpRule);
  router.delete('/admin/ip-rules/:ruleId', auth.authenticate, authorize('security:ip-rules:write'), security.removeIpRule);
  router.get('/admin/ip-bans', auth.authenticate, authorize('security:ip-rules:read'), security.listIpBans);
  router.delete('/admin/ip-bans/:ipKey', auth.authenticate, authorize('security:ip-rules:write'), security.liftIpBan);
  router.get('/admin/audit/verify', auth.authenticate, authorize('audit:verify'), security.verifyAudit);

  return router;
}
