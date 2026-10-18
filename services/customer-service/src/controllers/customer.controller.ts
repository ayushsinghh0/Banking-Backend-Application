import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CustomerService } from '../services/customer.service';
import { UnauthorizedError } from '@banksphere/common';

const createProfileSchema = z.object({
  fullName: z.string().min(2).max(100),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/, { message: 'Invalid phone number format' }),
  address: z.string().max(255).optional(),
  dateOfBirth: z
    .string()
    .datetime()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
});

const updateProfileSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  address: z.string().max(255).optional(),
  dateOfBirth: z
    .string()
    .datetime()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
});

export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /**
   * Helper to resolve authenticated user identity passed from Gateway
   */
  private getAuthenticatedUserId(req: Request): string {
    const userId = (req.headers['x-user-id'] as string) || (req as any).user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required: Missing user identification headers');
    }
    return userId;
  }

  public getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const { profile, fromCache } = await this.customerService.getProfileByUserId(userId);

      res.setHeader('X-Cache-Lookup', fromCache ? 'HIT' : 'MISS');
      res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  };

  public createMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const validated = createProfileSchema.parse(req.body);

      const profile = await this.customerService.createProfile({
        userId,
        fullName: validated.fullName,
        phoneNumber: validated.phoneNumber,
        address: validated.address,
        dateOfBirth: validated.dateOfBirth,
      });

      res.status(201).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  };

  public updateMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = this.getAuthenticatedUserId(req);
      const validated = updateProfileSchema.parse(req.body);

      const updated = await this.customerService.updateProfile(userId, validated);

      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };
}
