import crypto from 'crypto';
import { Prisma } from '../../generated/client';
import { AuthenticatedUser, HttpError, hasRecentStrongAuth } from '@banksphere/common';
import { EntryType, TransactionResult, TransactionStatus, TransactionType } from '../types';
import { DailyLimitExceededError } from '../errors';

export type TxClient = Prisma.TransactionClient;

export interface LockedAccount {
  id: string;
  kind: 'CUSTOMER' | 'TELLER_CASH' | 'VAULT_CASH' | 'CASH_SUSPENSE';
  balance: bigint;
  is_active: boolean;
  closed_at: Date | null;
  account_number: string;
  customer_id: string;
  currency: string;
  daily_limit: bigint;
}

export interface LedgerPolicy {
  /** Teller cash operations above this need a second BANK_ADMIN's approval */
  singleApprovalLimit: bigint;
  /** A teller's single-approval cash total per IST day; beyond it everything needs approval */
  tellerDailyLimit: bigint;
  /** Maximum outflow per customer per IST day across all their accounts */
  customerDailyOutflowLimit: bigint;
  /** Pending approvals expire after this many hours */
  approvalTtlHours: number;
  /** Transfers at or above this amount need an MFA-authenticated session */
  stepUpThreshold: bigint;
  /** A new beneficiary becomes usable after this many minutes (immediately with an MFA session) */
  beneficiaryCoolingMinutes: number;
  /** Total that may be sent to a beneficiary in its first 24 hours */
  newBeneficiaryLimit: bigint;
  /** Withdrawal authorisation codes expire after this many minutes */
  withdrawalCodeTtlMinutes: number;
  /** Withdrawal codes at or above this amount need recent strong authentication */
  withdrawalCodeStepUpThreshold: bigint;
  /** "Recent" strong authentication: a TOTP code verified within this many seconds */
  stepUpMaxAgeSeconds: number;
  /** A newly enrolled second factor only counts for step-up after this many hours */
  mfaFactorMinAgeHours: number;
}

export const defaultLedgerPolicy = (): LedgerPolicy => ({
  singleApprovalLimit: BigInt(process.env.CASH_SINGLE_APPROVAL_LIMIT_PAISE || '20000000'), // ₹2,00,000
  tellerDailyLimit: BigInt(process.env.TELLER_DAILY_LIMIT_PAISE || '100000000'), // ₹10,00,000
  customerDailyOutflowLimit: BigInt(process.env.CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE || '50000000'), // ₹5,00,000
  approvalTtlHours: Number(process.env.CASH_APPROVAL_TTL_HOURS || 24),
  stepUpThreshold: BigInt(process.env.STEP_UP_THRESHOLD_PAISE || '10000000'), // ₹1,00,000
  beneficiaryCoolingMinutes: Number(process.env.BENEFICIARY_COOLING_MINUTES ?? 60),
  newBeneficiaryLimit: BigInt(process.env.NEW_BENEFICIARY_LIMIT_PAISE || '5000000'), // ₹50,000
  withdrawalCodeTtlMinutes: Number(process.env.WITHDRAWAL_CODE_TTL_MINUTES || 15),
  withdrawalCodeStepUpThreshold: BigInt(process.env.WITHDRAWAL_CODE_STEP_UP_PAISE || '2500000'), // ₹25,000
  stepUpMaxAgeSeconds: Number(process.env.STEP_UP_MAX_AGE_SECONDS || 300),
  mfaFactorMinAgeHours: Number(process.env.MFA_FACTOR_MIN_AGE_HOURS ?? 24),
});

/** Recent TOTP verification on an established factor (see hasRecentStrongAuth) */
export function hasStepUp(actor: AuthenticatedUser, policy: LedgerPolicy): boolean {
  return hasRecentStrongAuth(actor, {
    maxAgeSeconds: policy.stepUpMaxAgeSeconds,
    minFactorAgeSeconds: policy.mfaFactorMinAgeHours * 3600,
  });
}

export const stepUpRequired = () =>
  new HttpError(
    403,
    'STEP_UP_REQUIRED',
    'Confirm this action with your authenticator: POST /api/v1/auth/mfa/step-up, then retry with the new access token'
  );

/** Hard ceiling on any balance (also a DB CHECK): keeps arithmetic far from BIGINT overflow */
export const MAX_BALANCE = 900_000_000_000_000_000n;

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily limits reset at midnight India Standard Time, returned as a UTC instant. */
export function startOfIstDay(now = new Date()): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(istMs / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** IST calendar date (YYYY-MM-DD) for teller business days */
export function istBusinessDate(now = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function generateReferenceId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Transaction-scoped advisory lock: serialises all debits of one customer / one teller */
export async function advisoryLock(tx: TxClient, key: string): Promise<void> {
  // pg_advisory_xact_lock returns void, which Prisma can't deserialise: cast it
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

export async function lockAccounts(tx: TxClient, ids: string[]): Promise<LockedAccount[]> {
  // DEADLOCK PREVENTION: rows are always locked in ascending id order
  const sorted = [...new Set(ids)].sort();
  // Don't queue forever behind a hot account: give up after 5s and let the client retry (503)
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  return tx.$queryRaw<LockedAccount[]>`
    SELECT id, kind::text AS kind, balance, is_active, closed_at, account_number, customer_id, currency, daily_limit
    FROM ledger_accounts
    WHERE id IN (${Prisma.join(sorted)})
    ORDER BY id ASC
    FOR UPDATE
  `;
}

export function assertBalanceCap(newBalance: bigint): void {
  if (newBalance > MAX_BALANCE) {
    throw new HttpError(422, 'BALANCE_LIMIT', 'This transaction would exceed the maximum account balance');
  }
}

/**
 * Per-account and per-customer daily outgoing limits. Must be called with the customer's advisory lock
 * and the account row lock held, so concurrent debits are serialised and can't race past either limit.
 */
export async function assertWithinDailyLimits(
  tx: TxClient,
  account: LockedAccount,
  amountInPaise: bigint,
  policy: LedgerPolicy
): Promise<void> {
  const since = startOfIstDay();
  const [accountSpent, customerSpent] = await Promise.all([
    tx.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId: account.id, entryType: EntryType.DEBIT, createdAt: { gte: since } },
    }),
    tx.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: {
        entryType: EntryType.DEBIT,
        createdAt: { gte: since },
        account: { customerId: account.customer_id, kind: 'CUSTOMER' },
      },
    }),
  ]);
  const spentOnAccount = accountSpent._sum.amount ?? 0n;
  if (spentOnAccount + amountInPaise > account.daily_limit) {
    const remaining = account.daily_limit - spentOnAccount;
    throw new DailyLimitExceededError(
      `Daily outgoing limit exceeded. Remaining today: ${(remaining > 0n ? remaining : 0n).toString()} paise`
    );
  }
  const spentByCustomer = customerSpent._sum.amount ?? 0n;
  if (spentByCustomer + amountInPaise > policy.customerDailyOutflowLimit) {
    throw new DailyLimitExceededError('Daily outgoing limit across all your accounts exceeded');
  }
}

export function toResult(transaction: {
  id: string;
  referenceId: string;
  type: string;
  status: string;
  amount: bigint;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  createdAt: Date;
}): TransactionResult {
  return {
    transactionId: transaction.id,
    referenceId: transaction.referenceId,
    type: transaction.type as TransactionType,
    status: transaction.status as TransactionStatus,
    amountInPaise: transaction.amount.toString(),
    sourceAccountId: transaction.sourceAccountId,
    destinationAccountId: transaction.destinationAccountId,
    createdAt: transaction.createdAt,
  };
}

/** TRANSACTIONAL OUTBOX: staged in the same DB transaction as the ledger writes */
export async function stageTransactionEvent(tx: TxClient, transactionId: string, payload: Record<string, unknown>): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: 'TRANSACTION',
      aggregateId: transactionId,
      eventType: 'transaction.completed.v1',
      payload: {
        eventId: crypto.randomUUID(),
        eventType: 'transaction.completed.v1',
        timestamp: new Date().toISOString(),
        transactionId,
        ...payload,
      } as Prisma.InputJsonValue,
      status: 'PENDING',
    },
  });
}

export async function audit(
  tx: TxClient | { auditLog: TxClient['auditLog'] },
  actorId: string,
  action: string,
  targetId: string,
  details?: Record<string, unknown>
): Promise<void> {
  await tx.auditLog.create({
    data: { actorId, action, targetId, details: details as Prisma.InputJsonValue | undefined },
  });
}

/**
 * Posts one balanced double-entry movement: `amount` is DEBITED from `debit` and CREDITED to `credit`.
 * Balance semantics: a CUSTOMER account's balance is what the bank owes the customer (credits increase
 * it); every cash account (drawer, vault, suspense) is an asset whose balance is the cash it should hold
 * (debits increase it). Hence sum(CUSTOMER balances) == sum(cash account balances) at all times.
 */
export async function postDoubleEntry(
  tx: TxClient,
  params: {
    transactionId: string;
    debit: LockedAccount;
    credit: LockedAccount;
    amount: bigint;
  }
): Promise<{ debitBalance: bigint; creditBalance: bigint }> {
  const delta = (account: LockedAccount, side: 'DEBIT' | 'CREDIT') =>
    (account.kind !== 'CUSTOMER') === (side === 'DEBIT') ? params.amount : -params.amount;

  const debitBalance = params.debit.balance + delta(params.debit, 'DEBIT');
  const creditBalance = params.credit.balance + delta(params.credit, 'CREDIT');
  assertBalanceCap(debitBalance);
  assertBalanceCap(creditBalance);

  await tx.ledgerEntry.create({
    data: {
      transactionId: params.transactionId,
      accountId: params.debit.id,
      entryType: EntryType.DEBIT,
      amount: params.amount,
      currency: params.debit.currency,
      balanceAfter: debitBalance,
    },
  });
  await tx.ledgerEntry.create({
    data: {
      transactionId: params.transactionId,
      accountId: params.credit.id,
      entryType: EntryType.CREDIT,
      amount: params.amount,
      currency: params.credit.currency,
      balanceAfter: creditBalance,
    },
  });
  await tx.ledgerAccount.update({ where: { id: params.debit.id }, data: { balance: debitBalance } });
  await tx.ledgerAccount.update({ where: { id: params.credit.id }, data: { balance: creditBalance } });
  return { debitBalance, creditBalance };
}
