import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  ROLES,
  UnauthorizedError,
  clientIpKey,
  getAuthenticatedUser,
  parsePagination,
  readBearerToken,
  verifyAccessToken,
} from '@banksphere/common';
import { Role } from '../../generated/client';
import { AuthService, LoginContext } from '../services/auth.service';
import { AdminRequestService } from '../services/admin-requests.service';
import { clearSessionCookie, issueTokens, readSessionCookie, wantsCookieTransport } from './session-transport';
import { clientOf } from './client-context';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Invalid email address format' })
  .max(254);

export const passwordSchema = z
  .string()
  .min(10, { message: 'Password must be at least 10 characters long' })
  .max(128, { message: 'Password must be at most 128 characters long' })
  .regex(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
  .regex(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
  .regex(/[0-9]/, { message: 'Password must contain at least one number' });

const oneTimeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, { message: 'Invalid token' });
const totpCodeSchema = z.string().regex(/^\d{6}$/, { message: 'Code must be 6 digits' });

// .strict() rejects unknown keys, so a client sending { role: 'BANK_ADMIN' } gets a 400
const registerSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

// Staff requests carry no password: the new staff member chooses it via the emailed activation link
const createStaffSchema = z
  .object({
    email: emailSchema,
    role: z.enum(['SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN']),
  })
  .strict();

const loginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(128),
});
const mfaLoginSchema = z.object({ challengeToken: oneTimeTokenSchema, code: totpCodeSchema }).strict();
const mfaSetupSchema = z.object({ password: z.string().min(1).max(128), enrolmentToken: oneTimeTokenSchema.optional() }).strict();
const mfaEnableSchema = z.object({ code: totpCodeSchema, enrolmentToken: oneTimeTokenSchema.optional() }).strict();
const stepUpSchema = z.object({ code: totpCodeSchema }).strict();
const activateSchema = z.object({ token: oneTimeTokenSchema, password: passwordSchema }).strict();
const requestIdParams = z.object({ requestId: z.string().uuid() });
const requestListQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });
const userListQuery = z.object({ role: z.enum(ROLES).optional(), q: z.string().trim().max(254).optional() });
const mfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: totpCodeSchema }).strict();

const refreshSchema = z.object({
  refreshToken: z.string().min(1, { message: 'refreshToken is required' }).max(256),
});
// Cookie transport: the body token is optional (the bs_rt cookie is used when it is absent)
const optionalRefreshSchema = z.object({ refreshToken: refreshSchema.shape.refreshToken.optional() });

const emailOnlySchema = z.object({ email: emailSchema }).strict();
const tokenOnlySchema = z.object({ token: oneTimeTokenSchema }).strict();
const resetSchema = z.object({ token: oneTimeTokenSchema, newPassword: passwordSchema }).strict();
const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();

const userIdParamsSchema = z.object({ userId: z.string().uuid() });
const userStatusSchema = z.object({ isActive: z.boolean() }).strict();

/** Client network for lockouts and bans, the client address for the staff network allowlist, and the device */
const loginContext = (req: Request): LoginContext => ({ network: clientIpKey(req.ip), ip: req.ip, userAgent: req.header('user-agent') });

/**
 * The refresh token of the request: from the body as always, or with cookie transport from the bs_rt cookie
 * when the body has none. No token at all is then a 401 (a browser without a session), not a 400.
 */
function presentedRefreshToken(req: Request): string {
  if (!wantsCookieTransport(req)) return refreshSchema.parse(req.body).refreshToken;
  const token = optionalRefreshSchema.parse(req.body ?? {}).refreshToken ?? readSessionCookie(req);
  if (!token) throw new UnauthorizedError('No active session');
  return token;
}

/** With cookie transport, a request that ends in 401 (no/invalid/expired/reused session) also drops the cookie */
async function clearingCookieOn401<T>(req: Request, res: Response, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err: any) {
    if (err?.statusCode === 401 && wantsCookieTransport(req)) clearSessionCookie(res);
    throw err;
  }
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminRequests: AdminRequestService
  ) {}

  public register = wrap(async (req, res) => {
    const validated = registerSchema.parse(req.body);
    const result = await this.authService.register(validated);
    res.status(202).json({ success: true, ...result });
  });

  public verifyEmail = wrap(async (req, res) => {
    const { token } = tokenOnlySchema.parse(req.body);
    await this.authService.verifyEmail(token);
    res.status(200).json({ success: true, message: 'Email address verified. You can now sign in.' });
  });

  public resendVerification = wrap(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    res.status(202).json({ success: true, ...(await this.authService.resendVerification(email)) });
  });

  public login = wrap(async (req, res) => {
    const validated = loginSchema.parse(req.body);
    const result = await this.authService.login(validated, loginContext(req));
    const data = 'tokens' in result ? { user: result.user, tokens: issueTokens(req, res, result.tokens) } : result;
    res.status(200).json({ success: true, data });
  });

  public loginMfa = wrap(async (req, res) => {
    const { challengeToken, code } = mfaLoginSchema.parse(req.body);
    const result = await this.authService.completeMfaLogin(challengeToken, code, loginContext(req));
    res.status(200).json({ success: true, data: { user: result.user, tokens: issueTokens(req, res, result.tokens) } });
  });

  public refresh = wrap(async (req, res) => {
    // A concurrent refresh (409) keeps the cookie: the other request has just set the newest one
    const tokens = await clearingCookieOn401(req, res, () => this.authService.refreshToken(presentedRefreshToken(req), clientOf(req)));
    res.status(200).json({ success: true, data: issueTokens(req, res, tokens) });
  });

  public logout = wrap(async (req, res) => {
    const refreshToken = await clearingCookieOn401(req, res, async () => presentedRefreshToken(req));
    // The access token is optional on logout; if present and valid it is revoked immediately
    let accessToken = null;
    const bearer = readBearerToken(req);
    if (bearer) {
      try {
        accessToken = verifyAccessToken(bearer);
      } catch {
        accessToken = null;
      }
    }
    await this.authService.logout(refreshToken, accessToken, clientOf(req));
    if (wantsCookieTransport(req)) clearSessionCookie(res);
    res.status(200).json({ success: true, message: 'Successfully logged out and session revoked' });
  });

  public mfaSetup = wrap(async (req, res) => {
    const { password, enrolmentToken } = mfaSetupSchema.parse(req.body);
    const result = await this.authService.beginMfaSetup(getAuthenticatedUser(req), password, enrolmentToken, loginContext(req));
    res.status(200).json({ success: true, data: result });
  });

  public mfaEnable = wrap(async (req, res) => {
    const { code, enrolmentToken } = mfaEnableSchema.parse(req.body);
    const tokens = await this.authService.enableMfa(getAuthenticatedUser(req), code, enrolmentToken);
    res.status(200).json({ success: true, data: { tokens: issueTokens(req, res, tokens) } });
  });

  public mfaStepUp = wrap(async (req, res) => {
    const { code } = stepUpSchema.parse(req.body);
    res.status(200).json({ success: true, data: await this.authService.stepUp(getAuthenticatedUser(req), code) });
  });

  public activateStaff = wrap(async (req, res) => {
    const { token, password } = activateSchema.parse(req.body);
    const { tokens, enrolmentToken } = await this.authService.activateStaff(token, password, clientOf(req));
    res.status(200).json({ success: true, data: { tokens: issueTokens(req, res, tokens), enrolmentToken } });
  });

  public mfaDisable = wrap(async (req, res) => {
    const { password, code } = mfaDisableSchema.parse(req.body);
    await this.authService.disableMfa(getAuthenticatedUser(req), password, code, loginContext(req));
    res.status(200).json({ success: true, message: 'Two-factor authentication disabled; please sign in again.' });
  });

  public forgotPassword = wrap(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    res.status(202).json({ success: true, ...(await this.authService.forgotPassword(email)) });
  });

  public resetPassword = wrap(async (req, res) => {
    const { token, newPassword } = resetSchema.parse(req.body);
    await this.authService.resetPassword(token, newPassword, clientOf(req));
    res.status(200).json({
      success: true,
      message: 'Password has been reset. All sessions were signed out; please sign in with your new password.',
    });
  });

  public changePassword = wrap(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const tokens = await this.authService.changePassword(getAuthenticatedUser(req), currentPassword, newPassword, loginContext(req));
    res.status(200).json({ success: true, data: { tokens: issueTokens(req, res, tokens) } });
  });

  public me = wrap(async (req, res) => {
    const user = await this.authService.getUser(getAuthenticatedUser(req).id);
    res.status(200).json({ success: true, data: user });
  });

  /** Four-eyes: records a request; a different BANK_ADMIN must approve it */
  public createStaffUser = wrap(async (req, res) => {
    const { email, role } = createStaffSchema.parse(req.body);
    const request = await this.adminRequests.request(getAuthenticatedUser(req), { type: 'CREATE_STAFF', email, role });
    res.status(202).json({ success: true, data: { requestId: request.id, status: request.status } });
  });

  /** Customers: immediate (fraud response). Staff targets: becomes a four-eyes request (202). */
  public setUserStatus = wrap(async (req, res) => {
    const { userId } = userIdParamsSchema.parse(req.params);
    const { isActive } = userStatusSchema.parse(req.body);
    const actor = getAuthenticatedUser(req);
    try {
      res.status(200).json({ success: true, data: await this.authService.setCustomerActive(actor, userId, isActive) });
    } catch (err: any) {
      if (err?.errorCode !== 'APPROVAL_REQUIRED') throw err;
      const request = await this.adminRequests.request(actor, { type: 'SET_USER_ACTIVE', userId, isActive });
      res.status(202).json({ success: true, data: { requestId: request.id, status: request.status } });
    }
  });

  public resetUserMfa = wrap(async (req, res) => {
    const { userId } = userIdParamsSchema.parse(req.params);
    const actor = getAuthenticatedUser(req);
    try {
      await this.authService.adminResetCustomerMfa(actor, userId);
      res.status(200).json({ success: true, message: 'MFA reset; the user must re-enrol at next sign-in.' });
    } catch (err: any) {
      if (err?.errorCode !== 'APPROVAL_REQUIRED') throw err;
      const request = await this.adminRequests.request(actor, { type: 'RESET_MFA', userId });
      res.status(202).json({ success: true, data: { requestId: request.id, status: request.status } });
    }
  });

  /** Staff user directory (BANK_ADMIN, SUPPORT) */
  public listUsers = wrap(async (req, res) => {
    const { role, q } = userListQuery.parse(req.query);
    const { limit, offset } = parsePagination(req.query);
    const users = await this.authService.listUsers(getAuthenticatedUser(req), { role: role as Role | undefined, q, limit, offset });
    res.json({ success: true, data: users, pagination: { limit, offset } });
  });

  public listAdminRequests = wrap(async (req, res) => {
    const { status } = requestListQuery.parse(req.query);
    const { limit, offset } = parsePagination(req.query);
    res.json({ success: true, data: await this.adminRequests.list(status, limit, offset), pagination: { limit, offset } });
  });

  public approveAdminRequest = wrap(async (req, res) => {
    const { requestId } = requestIdParams.parse(req.params);
    res.json({ success: true, data: await this.adminRequests.approve(getAuthenticatedUser(req), requestId) });
  });

  public rejectAdminRequest = wrap(async (req, res) => {
    const { requestId } = requestIdParams.parse(req.params);
    res.json({ success: true, data: await this.adminRequests.reject(getAuthenticatedUser(req), requestId) });
  });
}
