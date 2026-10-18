import { BankAccount } from '../../generated/client';

export { getAuthenticatedUser, isStaff } from '@banksphere/common';

export type BankAccountView = Omit<BankAccount, 'dailyLimit'> & {
  dailyLimit: string;
  dailyLimitPaise: string;
};
