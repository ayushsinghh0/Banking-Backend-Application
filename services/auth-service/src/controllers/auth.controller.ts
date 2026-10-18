import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '@banksphere/common';
import { AuthService } from '../services/auth.service';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Invalid email address format' })
  .max(254);

const passwordSchema = z
  .string()
  .min(8, { message: 'Password must be at least 8 characters long' })
  .max(128, { message: 'Password must be at most 128 characters long' })
  .regex(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
  .regex(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
  .regex(/[0-9]/, { message: 'Password must contain at least one number' });

// .strict() rejects unknown keys, so a client sending { role: 'BANK_ADMIN' } gets a 400
const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

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

const userIdParamsSchema = z.object({ userId: z.string().uuid() });
const userStatusSchema = z.object({ isActive: z.boolean() }).strict();

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  public register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = registerSchema.parse(req.body);
      const result = await this.authService.register(validated);
      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = loginSchema.parse(req.body);
      const result = await this.authService.login(validated);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = refreshSchema.parse(req.body);
      const tokens = await this.authService.refreshToken(validated.refreshToken);
      res.status(200).json({
        success: true,
        data: tokens,
      });
    } catch (error) {
      next(error);
    }
  };

  public logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = refreshSchema.parse(req.body);
      await this.authService.logout(validated.refreshToken);
      res.status(200).json({
        success: true,
        message: 'Successfully logged out and session revoked',
      });
    } catch (error) {
      next(error);
    }
  };

  public me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await this.authService.getUser(getAuthenticatedUser(req).id);
      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  };

  public createStaffUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createStaffSchema.parse(req.body);
      const user = await this.authService.createStaffUser(validated);
      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  };

  public setUserStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const { isActive } = userStatusSchema.parse(req.body);
      const user = await this.authService.setUserActive(userId, isActive);
      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  };
}
