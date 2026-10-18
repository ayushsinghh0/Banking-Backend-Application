import crypto from 'crypto';
import { PrismaClient, Prisma } from '../../generated/client';
import {
  AuthenticatedUser,
  ConflictError,
  ForbiddenError,
  HttpError,
  isStaff,
  logger,
} from '@banksphere/common';
import {
  TransferDTO,
  TransactionResult,
  TransactionType,
  TransactionStatus,
  EntryType,
  LedgerAccountProvisionDTO,
  LedgerAccountUpdateDTO,
  CashOperationDTO,
  CashOperationResult,
} from '../types';
import {
  NotFoundError,
  InsufficientFundsError,
  AccountInactiveError,
  SameAccountTransferError,
  InvalidAmountError,
  DailyLimitExceededError,
  CurrencyMismatchError,
} from '../errors';

type TxClient = Prisma.TransactionClient;

interface LockedAccount {
  id: string;
  balance: bigint;
  is_active: boolean;
  closed_at: Date | null;
  account_number: string;
  customer_id: string;
  currency: string;
  daily_limit: bigint;
}

export interface CashPolicy {
  /** Teller cash operations above this need a second BANK_ADMIN's approval */
  singleApprovalLimit: bigint;
  /** A teller's single-approval cash total per IST day; beyond it everything needs approval */
  tellerDailyLimit: bigint;
  /** Maximum outflow per customer per IST day across all their accounts */
  customerDailyOutflowLimit: bigint;
  /** Pending approvals expire after this many hours */
  approvalTtlHours: number;
}

export const defaultCashPolicy = (): CashPolicy => ({
  singleApprovalLimit: BigInt(process.env.CASH_SINGLE_APPROVAL_LIMIT_PAISE || '20000000'), // ₹2,00,000
  tellerDailyLimit: BigInt(process.env.TELLER_DAILY_LIMIT_PAISE || '100000000'), // ₹10,00,000
  customerDailyOutflowLimit: BigInt(process.env.CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE || '50000000'), // ₹5,00,000
  approvalTtlHours: Number(process.env.CASH_APPROVAL_TTL_HOURS || 24),
});

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily limits reset at midnight India Standard Time, returned as a UTC instant.
 */
export function startOfIstDay(now = new Date()): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(istMs / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** The one answer for "this destination can't receive money", whatever the reason */
const invalidDestination = () =>
  new HttpError(422, 'INVALID_DESTINATION', 'The destination account cannot receive this transfer');

export class LedgerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: CashPolicy = defaultCashPolicy()
  ) {}

  /**
   * Human-readable unique reference ID built from a CSPRNG suffix
   */
  private generateReferenceId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private inTransaction<T>(tx: TxClient | undefined, work: (tx: TxClient) => Promise<T>): Promise<T> {
    if (tx) return work(tx);
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  /** Transaction-scoped advisory lock: serialises all debits of one customer / one teller */
  private async advisoryLock(tx: TxClient, key: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  }

  private async lockAccounts(tx: TxClient, ids: string[]): Promise<LockedAccount[]> {
    // DEADLOCK PREVENTION: rows are always locked in ascending id order
    const sorted = [...new Set(ids)].sort();
    // Don't queue forever behind a hot account: give up after 5s and let the client retry (503)
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    return tx.$queryRaw<LockedAccount[]>`
      SELECT id, balance, is_active, closed_at, account_number, customer_id, currency, daily_limit
      FROM ledger_accounts
      WHERE id IN (${Prisma.join(sorted)})
      ORDER BY id ASC
      FOR UPDATE
    `;
  }

  private async assertWithinDailyLimits(
    tx: TxClient,
    account: LockedAccount,
    amountInPaise: bigint
  ): Promise<void> {
    // Called with the customer's advisory lock and the account row lock held, so concurrent debits are
    // serialised and can't race past either limit
    const since = startOfIstDay();
    const [accountSpent, customerSpent] = await Promise.all([
      tx.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { accountId: account.id, entryType: EntryType.DEBIT, createdAt: { gte: since } },
      }),
      tx.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { entryType: EntryType.DEBIT, createdAt: { gte: since }, account: { customerId: account.customer_id } },
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
    if (spentByCustomer + amountInPaise > this.policy.customerDailyOutflowLimit) {
      throw new DailyLimitExceededError('Daily outgoing limit across all your accounts exceeded');
    }
  }

  private toResult(transaction: {
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

  private async stageOutboxEvent(
    tx: TxClient,
    transactionId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    // TRANSACTIONAL OUTBOX: staged in the same DB transaction as the ledger writes
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

  private async audit(tx: TxClient, actorId: string, action: string, targetId: string, details?: Record<string, unknown>) {
    await tx.auditLog.create({
      data: { actorId, action, targetId, details: details as Prisma.InputJsonValue | undefined },
    });
  }

  // ---------------------------------------------------------------------------
  // Customer transfers
  // ---------------------------------------------------------------------------

  /**
   * Transfers between two accounts with strict double-entry ledgering, deterministic row locking and a
   * transactional outbox event. Only the owner of the source account can move its money (no staff
   * override). Checks run in an order that leaks nothing about other customers' accounts: the caller's
   * own account is validated first, and every unusable destination gets the same INVALID_DESTINATION.
   */
  public async executeTransfer(
    dto: TransferDTO,
    actor: AuthenticatedUser,
    txClient?: TxClient
  ): Promise<TransactionResult> {
    const { sourceAccountId, amountInPaise, description } = dto;

    if (amountInPaise <= 0n) {
      throw new InvalidAmountError();
    }

    const referenceId = dto.referenceId || this.generateReferenceId('TXN-TRF');

    return this.inTransaction(txClient, async (tx) => {
      let destinationAccountId = dto.destinationAccountId ?? null;
      if (!destinationAccountId && dto.destinationAccountNumber) {
        const dest = await tx.ledgerAccount.findUnique({
          where: { accountNumber: dto.destinationAccountNumber },
          select: { id: true },
        });
        destinationAccountId = dest?.id ?? null;
      }
      if (destinationAccountId === sourceAccountId) {
        throw new SameAccountTransferError();
      }

      const source0 = await tx.ledgerAccount.findUnique({ where: { id: sourceAccountId }, select: { customerId: true } });
      if (!source0 || source0.customerId !== actor.id) {
        // Not yours (or missing): indistinguishable, so account ids can't be probed
        throw new NotFoundError('Account not found');
      }
      await this.advisoryLock(tx, `customer-outflow:${actor.id}`);

      const accounts = await this.lockAccounts(tx, destinationAccountId ? [sourceAccountId, destinationAccountId] : [sourceAccountId]);
      const sourceAccount = accounts.find((a) => a.id === sourceAccountId)!;
      const destAccount = destinationAccountId ? accounts.find((a) => a.id === destinationAccountId) : undefined;

      // 1. Everything about the caller's own account first
      if (!sourceAccount.is_active || sourceAccount.closed_at) {
        throw new AccountInactiveError('Your account is frozen or closed');
      }
      if (sourceAccount.balance < amountInPaise) {
        throw new InsufficientFundsError();
      }
      await this.assertWithinDailyLimits(tx, sourceAccount, amountInPaise);

      // 2. Only then the destination, with a single uniform error
      if (!destAccount || !destAccount.is_active || destAccount.closed_at || destAccount.currency !== sourceAccount.currency) {
        if (destAccount && destAccount.currency !== sourceAccount.currency && destAccount.customer_id === actor.id) {
          throw new CurrencyMismatchError();
        }
        throw invalidDestination();
      }

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          amount: amountInPaise,
          currency: sourceAccount.currency,
          sourceAccountId,
          destinationAccountId: destAccount.id,
          initiatedBy: actor.id,
          description: description || `Transfer to account ${destAccount.account_number}`,
        },
      });

      const newSourceBalance = sourceAccount.balance - amountInPaise;
      const newDestBalance = destAccount.balance + amountInPaise;

      // DOUBLE-ENTRY: source DEBITED, destination CREDITED
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: sourceAccountId,
          entryType: EntryType.DEBIT,
          amount: amountInPaise,
          currency: sourceAccount.currency,
          balanceAfter: newSourceBalance,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: destAccount.id,
          entryType: EntryType.CREDIT,
          amount: amountInPaise,
          currency: destAccount.currency,
          balanceAfter: newDestBalance,
        },
      });

      await tx.ledgerAccount.update({ where: { id: sourceAccountId }, data: { balance: newSourceBalance } });
      await tx.ledgerAccount.update({ where: { id: destAccount.id }, data: { balance: newDestBalance } });

      await this.stageOutboxEvent(tx, transaction.id, {
        referenceId: transaction.referenceId,
        type: transaction.type,
        amountInPaise: amountInPaise.toString(),
        currency: transaction.currency,
        sourceAccountId,
        destinationAccountId: destAccount.id,
        sourceCustomerId: sourceAccount.customer_id,
        destinationCustomerId: destAccount.customer_id,
        initiatedBy: actor.id,
      });

      return this.toResult(transaction);
    });
  }

  // ---------------------------------------------------------------------------
  // Teller cash operations (maker-checker)
  // ---------------------------------------------------------------------------

  /**
   * A teller (BANK_ADMIN) records a cash deposit or withdrawal. Small amounts within the teller's daily
   * single-approval budget execute immediately; anything else waits for a different administrator.
   * Staff can never operate on accounts they own.
   */
  public async requestCashOperation(
    dto: CashOperationDTO,
    actor: AuthenticatedUser,
    txClient?: TxClient
  ): Promise<CashOperationResult> {
    if (dto.amountInPaise <= 0n) throw new InvalidAmountError();

    return this.inTransaction(txClient, async (tx) => {
      const account = await tx.ledgerAccount.findUnique({ where: { id: dto.accountId } });
      if (!account) throw new NotFoundError('Account not found');
      if (account.customerId === actor.id) {
        throw new ForbiddenError('Staff cannot perform cash operations on their own accounts');
      }
      if (!account.isActive || account.closedAt) throw new AccountInactiveError();

      await this.advisoryLock(tx, `teller:${actor.id}`);
      const executedToday = await tx.cashOperation.aggregate({
        _sum: { amount: true },
        where: {
          requestedBy: actor.id,
          status: 'EXECUTED',
          approvedBy: null,
          createdAt: { gte: startOfIstDay() },
        },
      });
      const usedBudget = executedToday._sum.amount ?? 0n;
      const needsApproval =
        dto.amountInPaise > this.policy.singleApprovalLimit ||
        usedBudget + dto.amountInPaise > this.policy.tellerDailyLimit;

      if (needsApproval) {
        const pending = await tx.cashOperation.create({
          data: {
            type: dto.type,
            status: 'PENDING_APPROVAL',
            accountId: dto.accountId,
            amount: dto.amountInPaise,
            description: dto.description,
            requestedBy: actor.id,
          },
        });
        await this.audit(tx, actor.id, `CASH_${dto.type}_REQUESTED`, pending.id, {
          accountId: dto.accountId,
          amountInPaise: dto.amountInPaise.toString(),
        });
        return { status: 'PENDING_APPROVAL', cashOperationId: pending.id };
      }

      const operation = await tx.cashOperation.create({
        data: {
          type: dto.type,
          status: 'EXECUTED',
          accountId: dto.accountId,
          amount: dto.amountInPaise,
          description: dto.description,
          requestedBy: actor.id,
          decidedAt: new Date(),
        },
      });
      const transaction = await this.postCash(tx, operation.id, dto, actor.id);
      await tx.cashOperation.update({ where: { id: operation.id }, data: { transactionId: transaction.transactionId } });
      await this.audit(tx, actor.id, `CASH_${dto.type}_EXECUTED`, operation.id, {
        accountId: dto.accountId,
        amountInPaise: dto.amountInPaise.toString(),
        transactionId: transaction.transactionId,
      });
      return { status: 'EXECUTED', cashOperationId: operation.id, transaction };
    });
  }

  /**
   * Second administrator approves a pending cash operation. The approver must differ from the requester
   * and must not own the account. Balance and limits are (re)checked at execution time.
   */
  public async approveCashOperation(
    cashOperationId: string,
    approver: AuthenticatedUser,
    txClient?: TxClient
  ): Promise<CashOperationResult> {
    return this.inTransaction(txClient, async (tx) => {
      const [op] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM cash_operations WHERE id = ${cashOperationId} FOR UPDATE
      `;
      if (!op) throw new NotFoundError('Cash operation not found');
      const operation = await tx.cashOperation.findUniqueOrThrow({ where: { id: cashOperationId } });

      if (operation.status !== 'PENDING_APPROVAL') {
        throw new ConflictError(`Cash operation is already ${operation.status}`);
      }
      if (operation.requestedBy === approver.id) {
        throw new ForbiddenError('A cash operation must be approved by a different administrator');
      }
      const account = await tx.ledgerAccount.findUnique({ where: { id: operation.accountId } });
      if (account?.customerId === approver.id) {
        throw new ForbiddenError('Staff cannot approve cash operations on their own accounts');
      }
      if (operation.createdAt.getTime() < Date.now() - this.policy.approvalTtlHours * 3600_000) {
        throw new ConflictError('This approval request has expired; reject it and ask the teller to submit a new one');
      }

      const transaction = await this.postCash(
        tx,
        operation.id,
        {
          type: operation.type,
          accountId: operation.accountId,
          amountInPaise: operation.amount,
          description: operation.description ?? undefined,
        },
        operation.requestedBy
      );
      await tx.cashOperation.update({
        where: { id: operation.id },
        data: { status: 'EXECUTED', approvedBy: approver.id, decidedAt: new Date(), transactionId: transaction.transactionId },
      });
      await this.audit(tx, approver.id, `CASH_${operation.type}_APPROVED`, operation.id, {
        requestedBy: operation.requestedBy,
        transactionId: transaction.transactionId,
      });
      return { status: 'EXECUTED', cashOperationId: operation.id, transaction };
    });
  }

  public async rejectCashOperation(cashOperationId: string, actor: AuthenticatedUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.cashOperation.updateMany({
        where: { id: cashOperationId, status: 'PENDING_APPROVAL' },
        data: { status: 'REJECTED', approvedBy: actor.id, decidedAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictError('Cash operation is not pending');
      await this.audit(tx, actor.id, 'CASH_OPERATION_REJECTED', cashOperationId);
    });
  }

  public async listCashOperations(
    status: 'PENDING_APPROVAL' | 'EXECUTED' | 'REJECTED' | undefined,
    limit: number,
    offset: number
  ) {
    const rows = await this.prisma.cashOperation.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map(({ amount, ...rest }) => ({ ...rest, amountInPaise: amount.toString() }));
  }

  /** Posts the ledger side of a cash operation (row lock, balance/limit checks, entry, outbox) */
  private async postCash(
    tx: TxClient,
    cashOperationId: string,
    dto: CashOperationDTO,
    tellerId: string
  ): Promise<TransactionResult> {
    const isDeposit = dto.type === 'DEPOSIT';
    const owner = await tx.ledgerAccount.findUnique({ where: { id: dto.accountId }, select: { customerId: true } });
    if (!owner) throw new NotFoundError('Account not found');
    if (!isDeposit) await this.advisoryLock(tx, `customer-outflow:${owner.customerId}`);

    const [account] = await this.lockAccounts(tx, [dto.accountId]);
    if (!account.is_active || account.closed_at) throw new AccountInactiveError();
    if (!isDeposit) {
      if (account.balance < dto.amountInPaise) throw new InsufficientFundsError();
      await this.assertWithinDailyLimits(tx, account, dto.amountInPaise);
    }

    const transaction = await tx.transaction.create({
      data: {
        referenceId: this.generateReferenceId(isDeposit ? 'TXN-DEP' : 'TXN-WTH'),
        type: isDeposit ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
        status: TransactionStatus.COMPLETED,
        amount: dto.amountInPaise,
        currency: account.currency,
        ...(isDeposit ? { destinationAccountId: account.id } : { sourceAccountId: account.id }),
        initiatedBy: tellerId,
        description: dto.description || (isDeposit ? 'Cash deposit at branch' : 'Cash withdrawal at branch'),
      },
    });

    const newBalance = isDeposit ? account.balance + dto.amountInPaise : account.balance - dto.amountInPaise;
    await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        accountId: account.id,
        entryType: isDeposit ? EntryType.CREDIT : EntryType.DEBIT,
        amount: dto.amountInPaise,
        currency: account.currency,
        balanceAfter: newBalance,
      },
    });
    await tx.ledgerAccount.update({ where: { id: account.id }, data: { balance: newBalance } });

    await this.stageOutboxEvent(tx, transaction.id, {
      referenceId: transaction.referenceId,
      type: transaction.type,
      amountInPaise: dto.amountInPaise.toString(),
      currency: transaction.currency,
      ...(isDeposit
        ? { destinationAccountId: account.id, destinationCustomerId: account.customer_id }
        : { sourceAccountId: account.id, sourceCustomerId: account.customer_id }),
      initiatedBy: tellerId,
      cashOperationId,
    });

    return this.toResult(transaction);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async getReadableAccount(accountId: string, actor: AuthenticatedUser) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account || (account.customerId !== actor.id && !isStaff(actor))) {
      throw new NotFoundError('Account not found');
    }
    return account;
  }

  /**
   * Retrieves an account balance authoritatively from the ledger (owner or staff)
   */
  public async getAccountBalance(
    accountId: string,
    actor: AuthenticatedUser
  ): Promise<{ accountId: string; balanceInPaise: string; currency: string }> {
    const account = await this.getReadableAccount(accountId, actor);
    return {
      accountId: account.id,
      balanceInPaise: account.balance.toString(),
      currency: account.currency,
    };
  }

  /**
   * Returns paginated transaction history for an account (owner or staff)
   */
  public async getTransactionHistory(accountId: string, actor: AuthenticatedUser, limit = 20, offset = 0) {
    await this.getReadableAccount(accountId, actor);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId },
      include: { transaction: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });

    return entries.map((entry) => ({
      entryId: entry.id,
      transactionId: entry.transactionId,
      referenceId: entry.transaction.referenceId,
      type: entry.transaction.type,
      entryType: entry.entryType,
      amountInPaise: entry.amount.toString(),
      balanceAfterInPaise: entry.balanceAfter.toString(),
      description: entry.transaction.description,
      createdAt: entry.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal (service-to-service) ledger account management, called by account-service
  // ---------------------------------------------------------------------------

  /**
   * Idempotent: re-provisioning an existing account with the same identity is a no-op.
   */
  public async provisionAccount(dto: LedgerAccountProvisionDTO) {
    const existing = await this.prisma.ledgerAccount.findUnique({ where: { id: dto.id } });
    if (existing) {
      if (existing.accountNumber !== dto.accountNumber || existing.customerId !== dto.customerId) {
        throw new ConflictError('Ledger account id already provisioned with a different identity');
      }
      return existing;
    }
    return this.prisma.ledgerAccount.create({
      data: {
        id: dto.id,
        accountNumber: dto.accountNumber,
        customerId: dto.customerId,
        currency: dto.currency,
        dailyLimit: dto.dailyLimitPaise,
        isActive: dto.isActive,
      },
    });
  }

  public async updateAccount(accountId: string, dto: LedgerAccountUpdateDTO) {
    return this.prisma.$transaction(async (tx) => {
      const [account] = await this.lockAccounts(tx, [accountId]);
      if (!account) throw new NotFoundError('Ledger account not found');
      if (account.closed_at) throw new ConflictError('Ledger account is closed');
      return tx.ledgerAccount.update({
        where: { id: accountId },
        data: {
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.dailyLimitPaise !== undefined && { dailyLimit: dto.dailyLimitPaise }),
        },
      });
    });
  }

  /**
   * Closes an account. The ledger is the authority: the zero-balance check and the close happen under
   * the row lock, so a transfer can't land between "balance is 0" and "closed". Idempotent.
   */
  public async closeAccount(accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [account] = await this.lockAccounts(tx, [accountId]);
      if (!account) throw new NotFoundError('Ledger account not found');
      if (account.closed_at) return;
      if (account.balance !== 0n) {
        throw new HttpError(409, 'BALANCE_NOT_ZERO', 'Account balance must be zero before the account can be closed');
      }
      await tx.ledgerAccount.update({ where: { id: accountId }, data: { isActive: false, closedAt: new Date() } });
    });
  }

  private snapshot(account: {
    id: string;
    accountNumber: string;
    customerId: string;
    balance: bigint;
    dailyLimit: bigint;
    currency: string;
    isActive: boolean;
    closedAt: Date | null;
  }) {
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      customerId: account.customerId,
      balanceInPaise: account.balance.toString(),
      dailyLimitPaise: account.dailyLimit.toString(),
      currency: account.currency,
      isActive: account.isActive,
      closed: Boolean(account.closedAt),
    };
  }

  public async getAccountSnapshot(accountId: string) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundError('Ledger account not found');
    }
    return this.snapshot(account);
  }

  public async getAccountSnapshots(ids: string[]) {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { id: { in: ids } } });
    return accounts.map((a) => this.snapshot(a));
  }

  // ---------------------------------------------------------------------------
  // Integrity
  // ---------------------------------------------------------------------------

  /**
   * Ledger invariant check: every account's balance must equal the net of its entries. Any mismatch
   * indicates tampering or a bug and is logged as an alert-level error.
   */
  public async reconcileBalances(): Promise<{ checked: number; mismatches: string[] }> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT a.id
      FROM ledger_accounts a
      LEFT JOIN (
        SELECT account_id,
               SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS net
        FROM ledger_entries GROUP BY account_id
      ) e ON e.account_id = a.id
      WHERE a.balance <> COALESCE(e.net, 0)
    `;
    const [{ count }] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM ledger_accounts`;
    const mismatches = rows.map((r) => r.id);
    if (mismatches.length) {
      logger.error({ mismatches, alert: 'LEDGER_RECONCILIATION_FAILED' }, 'Ledger balances do not match their entries');
    }
    return { checked: Number(count), mismatches };
  }
}
