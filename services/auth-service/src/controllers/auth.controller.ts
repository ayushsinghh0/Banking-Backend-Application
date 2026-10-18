import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser, readBearerToken, verifyAccessToken } from '@banksphere/common';
import { AuthService } from '../services/auth.service';

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

const oneTimeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{20,128}$/, { message: 'Invalid token' });

// .strict() rejects unknown keys, so a client sending { role: 'BANK_ADMIN' } gets a 400
const registerSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

const createStaffSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(['CUSTOMER', 'BANK_ADMIN', 'SUPPORT']),
  })
  .strict();

const loginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(128),
});

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
  constructor(private readonly authService: AuthService) {}

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
    const result = await this.authService.login(validated);
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

  public createStaffUser = wrap(async (req, res) => {
    const validated = createStaffSchema.parse(req.body);
    const user = await this.authService.createStaffUser(validated);
    res.status(201).json({ success: true, data: user });
  });

  public setUserStatus = wrap(async (req, res) => {
    const { userId } = userIdParamsSchema.parse(req.params);
    const { isActive } = userStatusSchema.parse(req.body);
    const user = await this.authService.setUserActive(userId, isActive);
    res.status(200).json({ success: true, data: user });
  });
}
