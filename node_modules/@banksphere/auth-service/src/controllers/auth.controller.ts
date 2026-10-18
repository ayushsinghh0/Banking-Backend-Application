import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service';

const registerSchema = z.object({
  email: z.string().email({ message: 'Invalid email address format' }),
  password: z
    .string()
    .min(8, { message: 'Password must be at least 8 characters long' })
    .regex(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
    .regex(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
    .regex(/[0-9]/, { message: 'Password must contain at least one number' }),
  role: z.enum(['CUSTOMER', 'BANK_ADMIN', 'SUPPORT']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, { message: 'refreshToken is required' }),
});

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
}
