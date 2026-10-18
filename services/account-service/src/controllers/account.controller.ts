import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AccountService } from '../services/account.service';
import { UnauthorizedError } from '@banksphere/common';
import { AccountType, AccountStatus } from '../generated/client';

const createAccountSchema = z.object({
  accountType: z.enum(['SAVINGS', 'CURRENT']).optional(),
  currency: z.string().length(3).default('INR'),
  dailyLimitPaise: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .transform((val) => (val ? BigInt(val) : undefined)),
});

const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
});

export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  private getAuthContext(req: Request): { userId: string; role: string; isAdmin: boolean } {
    const userId = (req.headers['x-user-id'] as string) || (req as any).user?.id;
    const role = ((req.headers['x-user-role'] as string) || (req as any).user?.role || 'CUSTOMER').toUpperCase();

    if (!userId) {
      throw new UnauthorizedError('Authentication required: Missing user identification headers');
    }

    return {
      userId,
      role,
      isAdmin: role === 'BANK_ADMIN' || role === 'ADMIN',
    };
  }

  public create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = this.getAuthContext(req);
      const validated = createAccountSchema.parse(req.body);

      const account = await this.accountService.createAccount({
        customerId: userId,
        accountType: validated.accountType as AccountType,
        currency: validated.currency,
        dailyLimitPaise: validated.dailyLimitPaise,
      });

      res.status(201).json({
        success: true,
        data: {
          ...account,
          dailyLimitPaise: account.dailyLimit.toString(),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = this.getAuthContext(req);
      const accounts = await this.accountService.getAccountsByCustomerId(userId);

      res.status(200).json({
        success: true,
        data: accounts.map((a) => ({
          ...a,
          dailyLimitPaise: a.dailyLimit.toString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  };

  public getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId, isAdmin } = this.getAuthContext(req);
      const accountId = req.params.accountId;

      const account = await this.accountService.getAccountById(accountId, userId, isAdmin);

      res.status(200).json({
        success: true,
        data: {
          ...account,
          dailyLimitPaise: account.dailyLimit.toString(),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public updateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId, isAdmin } = this.getAuthContext(req);
      const accountId = req.params.accountId;
      const validated = updateStatusSchema.parse(req.body);

      const updated = await this.accountService.updateAccountStatus(
        accountId,
        validated.status as AccountStatus,
        userId,
        isAdmin
      );

      res.status(200).json({
        success: true,
        data: {
          ...updated,
          dailyLimitPaise: updated.dailyLimit.toString(),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
