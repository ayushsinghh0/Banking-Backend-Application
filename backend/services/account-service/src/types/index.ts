import { BankAccount } from '../../generated/client';

export { getAuthenticatedUser, isStaff } from '@banksphere/common';

export type BankAccountView = Omit<BankAccount, 'dailyLimit' | 'bankLimitCeiling'> & {
  dailyLimit: string;
  dailyLimitPaise: string;
  /** Daily limit last set by the bank: the owner can raise the limit only up to this (and the customer cap) */
  bankLimitCeilingPaise: string | null;
};

/** Why a staff member read a customer's account data (account_staff_access_log.action) */
export type StaffAccessAction = 'VIEW_ACCOUNT' | 'LIST_ACCOUNTS' | 'LOOKUP_ACCOUNT';

/** What a staff lookup by account number reveals */
export type AccountLookupView = Pick<BankAccount, 'id' | 'accountNumber' | 'customerId' | 'accountType' | 'status'>;
