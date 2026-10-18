export type MoneyPaise = bigint; // Represents amount in minor units (e.g., ₹10.50 = 1050n)

export enum TransactionType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
  TRANSFER = 'TRANSFER',
  CASH_TRANSFER = 'CASH_TRANSFER',
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

export interface CashOperationDTO {
  type: 'DEPOSIT' | 'WITHDRAWAL';
  accountId: string;
  amountInPaise: bigint;
  description?: string;
  /** Required for withdrawals: the customer's single-use authorisation code */
  authorizationCode?: string;
}

export type CashOperationResult =
  | { status: 'EXECUTED'; cashOperationId: string; transaction: TransactionResult }
  | { status: 'PENDING_APPROVAL'; cashOperationId: string };

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
  /** account-service control-state version; applied only if newer than the ledger's */
  version: number;
}
