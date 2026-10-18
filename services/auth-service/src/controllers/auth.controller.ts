import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { clientIpKey, getAuthenticatedUser, parsePagination, readBearerToken, verifyAccessToken } from '@banksphere/common';
import { AuthService } from '../services/auth.service';
import { AdminRequestService } from '../services/admin-requests.service';

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
const mfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: totpCodeSchema }).strict();

const refreshSchema = z.object({
  refreshToken: z.string().min(1, { message: 'refreshToken is required' }).max(256),
});

const emailOnlySchema = z.object({ email: emailSchema }).strict();
const tokenOnlySchema = z.object({ token: oneTimeTokenSchema }).strict();
const resetSchema = z.object({ token: oneTimeTokenSchema, newPassword: passwordSchema }).strict();
const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();

const userIdParamsSchema = z.object({ userId: z.string().uuid() });
const userStatusSchema = z.object({ isActive: z.boolean() }).strict();

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
    const result = await this.authService.login(validated, { network: clientIpKey(req.ip) });
    res.status(200).json({ success: true, data: result });
  });

  public loginMfa = wrap(async (req, res) => {
    const { challengeToken, code } = mfaLoginSchema.parse(req.body);
    const result = await this.authService.completeMfaLogin(challengeToken, code);
    res.status(200).json({ success: true, data: result });
  });

  public refresh = wrap(async (req, res) => {
    const validated = refreshSchema.parse(req.body);
    const tokens = await this.authService.refreshToken(validated.refreshToken);
    res.status(200).json({ success: true, data: tokens });
  });

  public logout = wrap(async (req, res) => {
    const validated = refreshSchema.parse(req.body);
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
    await this.authService.logout(validated.refreshToken, accessToken);
    res.status(200).json({ success: true, message: 'Successfully logged out and session revoked' });
  });

  public mfaSetup = wrap(async (req, res) => {
    const { password, enrolmentToken } = mfaSetupSchema.parse(req.body);
    const result = await this.authService.beginMfaSetup(getAuthenticatedUser(req), password, enrolmentToken);
    res.status(200).json({ success: true, data: result });
  });

  public mfaEnable = wrap(async (req, res) => {
    const { code, enrolmentToken } = mfaEnableSchema.parse(req.body);
    const tokens = await this.authService.enableMfa(getAuthenticatedUser(req), code, enrolmentToken);
    res.status(200).json({ success: true, data: { tokens } });
  });

  public mfaStepUp = wrap(async (req, res) => {
    const { code } = stepUpSchema.parse(req.body);
    res.status(200).json({ success: true, data: await this.authService.stepUp(getAuthenticatedUser(req), code) });
  });

  public activateStaff = wrap(async (req, res) => {
    const { token, password } = activateSchema.parse(req.body);
    const result = await this.authService.activateStaff(token, password);
    res.status(200).json({ success: true, data: result });
  });

  public mfaDisable = wrap(async (req, res) => {
    const { password, code } = mfaDisableSchema.parse(req.body);
    await this.authService.disableMfa(getAuthenticatedUser(req), password, code);
    res.status(200).json({ success: true, message: 'Two-factor authentication disabled; please sign in again.' });
  });

  public forgotPassword = wrap(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    res.status(202).json({ success: true, ...(await this.authService.forgotPassword(email)) });
  });

  public resetPassword = wrap(async (req, res) => {
    const { token, newPassword } = resetSchema.parse(req.body);
    await this.authService.resetPassword(token, newPassword);
    res.status(200).json({
      success: true,
      message: 'Password has been reset. All sessions were signed out; please sign in with your new password.',
    });
  });

  public changePassword = wrap(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const tokens = await this.authService.changePassword(getAuthenticatedUser(req), currentPassword, newPassword);
    res.status(200).json({ success: true, data: { tokens } });
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
