import crypto from 'crypto';
import { Prisma } from '../../generated/client';
import { AuthenticatedUser, HttpError, hasRecentStrongAuth } from '@banksphere/common';
import { EntryType, TransactionResult, TransactionStatus, TransactionType } from '../types';
import { DailyLimitExceededError } from '../errors';
import { notePosting } from './ledger-commits';
import { appendAudit } from './audit-chain';

export type TxClient = Prisma.TransactionClient;

export type LedgerAccountKindName = 'CUSTOMER' | 'TELLER_CASH' | 'VAULT_CASH' | 'CASH_SUSPENSE' | 'PAYMENT_CLEARING';

/**
 * Asset accounts of the bank (debit-normal: debits increase the balance): teller drawers, the vault, cash
 * suspense and PAYMENT_CLEARING (money receivable from the payment provider). CUSTOMER accounts are the
 * bank's liability to its customers (credit-normal). Reconciliation checks
 * sum(CUSTOMER balances) == sum(asset balances).
 */
export const ASSET_KINDS = ['TELLER_CASH', 'VAULT_CASH', 'CASH_SUSPENSE', 'PAYMENT_CLEARING'] as const;

export function isAssetKind(kind: string): boolean {
  if (kind === 'CUSTOMER') return false;
  if ((ASSET_KINDS as readonly string[]).includes(kind)) return true;
  // A kind without a sign convention must never be posted to: its balance would silently go the wrong way
  throw new Error(`Ledger account kind ${kind} has no balance convention`);
}

export interface LockedAccount {
  id: string;
  kind: LedgerAccountKindName;
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
  /** Beneficiary add attempts (adds, re-adds, failed lookups) per customer per rolling 24 hours */
  maxNewBeneficiariesPerDay: number;
}

/**
 * Policy numbers (and the service's other numeric settings) come from the environment. Unset means the
 * default; anything else must be a plain whole number within range. An empty string, a typo or a negative
 * value is a configuration error that stops the service at startup, instead of a 0 that silently disables
 * a control or a NaN that fails every request.
 */
export function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!/^\d{1,15}$/.test(value) || Number(value) < min) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number >= ${min}`);
  }
  return Number(value);
}

function policyPaise(name: string, fallback: bigint, min: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!/^\d{1,18}$/.test(value) || BigInt(value) < min) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number of paise >= ${min}`);
  }
  return BigInt(value);
}

export const defaultLedgerPolicy = (): LedgerPolicy => ({
  singleApprovalLimit: policyPaise('CASH_SINGLE_APPROVAL_LIMIT_PAISE', 20_000_000n, 0n), // ₹2,00,000
  tellerDailyLimit: policyPaise('TELLER_DAILY_LIMIT_PAISE', 100_000_000n, 0n), // ₹10,00,000
  customerDailyOutflowLimit: policyPaise('CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE', 50_000_000n, 1n), // ₹5,00,000
  approvalTtlHours: envNumber('CASH_APPROVAL_TTL_HOURS', 24, 1),
  stepUpThreshold: policyPaise('STEP_UP_THRESHOLD_PAISE', 10_000_000n, 0n), // ₹1,00,000
  beneficiaryCoolingMinutes: envNumber('BENEFICIARY_COOLING_MINUTES', 60, 0),
  newBeneficiaryLimit: policyPaise('NEW_BENEFICIARY_LIMIT_PAISE', 5_000_000n, 0n), // ₹50,000
  withdrawalCodeTtlMinutes: envNumber('WITHDRAWAL_CODE_TTL_MINUTES', 15, 1),
  withdrawalCodeStepUpThreshold: policyPaise('WITHDRAWAL_CODE_STEP_UP_PAISE', 2_500_000n, 0n), // ₹25,000
  stepUpMaxAgeSeconds: envNumber('STEP_UP_MAX_AGE_SECONDS', 300, 1),
  mfaFactorMinAgeHours: envNumber('MFA_FACTOR_MIN_AGE_HOURS', 24, 0),
  maxNewBeneficiariesPerDay: envNumber('MAX_NEW_BENEFICIARIES_PER_DAY', 10, 1),
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

/** Debits that are not the customer's own outflow (see assertWithinDailyLimits) */
export const CUSTOMER_LIMIT_EXEMPT_TYPES: TransactionType[] = [TransactionType.TOP_UP_REFUND];

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
  // Refunds of top-ups are bank-initiated (the money goes back to where it came from): they don't use up
  // the customer's own daily allowance
  const customerOutflow = { type: { notIn: CUSTOMER_LIMIT_EXEMPT_TYPES } };
  const [accountSpent, customerSpent] = await Promise.all([
    tx.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId: account.id, entryType: EntryType.DEBIT, createdAt: { gte: since }, transaction: customerOutflow },
    }),
    tx.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: {
        entryType: EntryType.DEBIT,
        createdAt: { gte: since },
        account: { customerId: account.customer_id, kind: 'CUSTOMER' },
        transaction: customerOutflow,
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

/**
 * TRANSACTIONAL OUTBOX: staged in the same DB transaction as the ledger writes. The Kafka key (outbox
 * aggregate) is the customer account the event is about (the source of a transfer or withdrawal, the
 * destination of a deposit or top-up), so one account's events are published and consumed in order: a
 * top-up is always scored before the transfer that moves it on (fraud's pass-through rule relies on it).
 */
export async function stageTransactionEvent(
  tx: TxClient,
  transactionId: string,
  accountKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: 'TRANSACTION',
      aggregateId: accountKey,
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

/**
 * A refusal that must leave a durable trace (an audit row, a recorded dispute). Thrown inside a
 * transaction, those writes would roll back with it; returned instead, the transaction commits them and
 * `commitThenRefuse` throws the error once the commit is done. Only for transactions that have written
 * nothing else by the time they refuse.
 */
export class Refusal {
  constructor(readonly error: Error) {}
}

export async function commitThenRefuse<T>(transaction: Promise<T | Refusal>): Promise<T> {
  const result = await transaction;
  if (result instanceof Refusal) throw result.error;
  return result;
}

/**
 * Appends a hash-chained audit row inside the caller's transaction (see appendAudit): call it after the
 * transaction's other locks. Outside a transaction, wrap it: prisma.$transaction((tx) => audit(tx, ...)).
 */
export async function audit(
  tx: TxClient,
  actorId: string,
  action: string,
  targetId: string,
  details?: Record<string, unknown>
): Promise<void> {
  await appendAudit(tx, actorId, action, targetId, details);
}

/**
 * Posts one balanced double-entry movement: `amount` is DEBITED from `debit` and CREDITED to `credit`.
 * Balance semantics: a CUSTOMER account's balance is what the bank owes the customer (credits increase
 * it); every asset account (drawer, vault, suspense, payment clearing) holds what the bank should have
 * (debits increase it). Hence sum(CUSTOMER balances) == sum(asset balances) at all times.
 *
 * Must run inside LedgerCommits.run: the posting is recorded there, and the touched accounts' cached
 * balances and history are invalidated once (and only if) the transaction commits.
 */
export async function postDoubleEntry(
  tx: TxClient,
  params: {
    transactionId: string;
    type: TransactionType;
    debit: LockedAccount;
    credit: LockedAccount;
    amount: bigint;
  }
): Promise<{ debitBalance: bigint; creditBalance: bigint }> {
  notePosting(params.type, [params.debit.id, params.credit.id]);
  const delta = (account: LockedAccount, side: 'DEBIT' | 'CREDIT') =>
    isAssetKind(account.kind) === (side === 'DEBIT') ? params.amount : -params.amount;

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
