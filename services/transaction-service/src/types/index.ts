export type MoneyPaise = bigint; // Represents amount in minor units (e.g., ₹10.50 = 1050n)

export enum TransactionType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
  TRANSFER = 'TRANSFER',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

export enum EntryType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export enum IdempotencyStatus {
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface DepositDTO {
  accountId: string;
  amountInPaise: bigint;
  description?: string;
  referenceId?: string;
}

export interface WithdrawDTO {
  accountId: string;
  amountInPaise: bigint;
  description?: string;
  referenceId?: string;
}

export interface TransferDTO {
  sourceAccountId: string;
  destinationAccountId?: string;
  destinationAccountNumber?: string;
  amountInPaise: bigint;
  description?: string;
  referenceId?: string;
}

export interface TransactionResult {
  transactionId: string;
  referenceId: string;
  type: TransactionType;
  status: TransactionStatus;
  amountInPaise: string; // Serialized string representation of BigInt for JSON safety
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  createdAt: Date;
}

export interface LedgerAccountProvisionDTO {
  id: string;
  accountNumber: string;
  customerId: string;
  currency: string;
  dailyLimitPaise: bigint;
  isActive: boolean;
}

export interface LedgerAccountUpdateDTO {
  isActive?: boolean;
  dailyLimitPaise?: bigint;
}
