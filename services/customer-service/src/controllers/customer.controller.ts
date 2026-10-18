import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CustomerService } from '../services/customer.service';
import { getAuthenticatedUser } from '@banksphere/common';

const createProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/, { message: 'Invalid phone number format' }),
  address: z.string().max(255).optional(),
  dateOfBirth: z
    .string()
    .datetime()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
});

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  address: z.string().max(255).optional(),
  dateOfBirth: z
    .string()
    .datetime()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
});

const userIdParamsSchema = z.object({ userId: z.string().uuid() });

const kycSchema = z
  .object({ kycStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']), expectedVersion: z.number().int().positive() })
  .strict();

export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /**
   * Identity comes only from the verified access token (see authenticate middleware)
   */
  private getAuthenticatedUserId(req: Request): string {
    return getAuthenticatedUser(req).id;
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

  public getByUserId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const profile = await this.customerService.getProfileForStaff(getAuthenticatedUser(req), userId);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  };

  public updateKycStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      const { kycStatus, expectedVersion } = kycSchema.parse(req.body);
      const profile = await this.customerService.updateKycStatus(getAuthenticatedUser(req), userId, kycStatus, expectedVersion);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  };

  public getKycHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = userIdParamsSchema.parse(req.params);
      res.status(200).json({ success: true, data: await this.customerService.getKycHistory(userId) });
    } catch (error) {
      next(error);
    }
  };
}
