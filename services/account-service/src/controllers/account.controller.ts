import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AccountService } from '../services/account.service';
import { getAuthenticatedUser, isStaff, BankAccountView } from '../types';
import { AccountType, AccountStatus, BankAccount } from '../../generated/client';

const paiseString = z
  .string()
  .regex(/^\d{1,18}$/, { message: 'Must be a positive integer string in paise' })
  .transform((val) => BigInt(val));

const createAccountSchema = z
  .object({
    accountType: z.enum(['SAVINGS', 'CURRENT']).optional(),
    currency: z.literal('INR').default('INR'),
    dailyLimitPaise: paiseString.optional(),
  })
  .strict();

const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
});

const updateLimitSchema = z.object({ dailyLimitPaise: paiseString }).strict();

const accountIdParams = z.object({ accountId: z.string().uuid() });

const listQuerySchema = z.object({ customerId: z.string().uuid().optional() });

function toView(account: BankAccount): BankAccountView {
  return {
    ...account,
    dailyLimit: account.dailyLimit.toString(),
    dailyLimitPaise: account.dailyLimit.toString(),
  };
}

export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  public create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const validated = createAccountSchema.parse(req.body);

      const account = await this.accountService.createAccount(
        {
          customerId: actor.id,
          accountType: validated.accountType as AccountType | undefined,
          currency: validated.currency,
          dailyLimitPaise: validated.dailyLimitPaise,
        },
        actor
      );

      res.status(201).json({ success: true, data: toView(account) });
    } catch (error) {
      next(error);
    }
  };

  public list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const { customerId } = listQuerySchema.parse(req.query);
      // Staff may list any customer's accounts; customers always get their own
      const targetCustomerId = isStaff(actor) && customerId ? customerId : actor.id;
      const accounts = await this.accountService.getAccountsByCustomerId(targetCustomerId);

      res.status(200).json({ success: true, data: accounts.map(toView) });
    } catch (error) {
      next(error);
    }
  };

  public getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const { accountId } = accountIdParams.parse(req.params);
      const account = await this.accountService.getAccountById(accountId, actor);

      res.status(200).json({ success: true, data: toView(account) });
    } catch (error) {
      next(error);
    }
  };

  public updateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const { accountId } = accountIdParams.parse(req.params);
      const validated = updateStatusSchema.parse(req.body);

      const updated = await this.accountService.updateAccountStatus(
        accountId,
        validated.status as AccountStatus,
        actor
      );

      res.status(200).json({ success: true, data: toView(updated) });
    } catch (error) {
      next(error);
    }
  };

  public updateDailyLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const { accountId } = accountIdParams.parse(req.params);
      const { dailyLimitPaise } = updateLimitSchema.parse(req.body);

      const updated = await this.accountService.updateDailyLimit(accountId, dailyLimitPaise, actor);
      res.status(200).json({ success: true, data: toView(updated) });
    } catch (error) {
      next(error);
    }
  };
}
