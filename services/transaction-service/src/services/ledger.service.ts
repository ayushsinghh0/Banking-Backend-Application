import crypto from 'crypto';
import { PrismaClient, Prisma } from '../../generated/client';
import { AuthenticatedUser, ConflictError, isStaff } from '@banksphere/common';
import {
  DepositDTO,
  WithdrawDTO,
  TransferDTO,
  TransactionResult,
  TransactionType,
  TransactionStatus,
  EntryType,
  LedgerAccountProvisionDTO,
  LedgerAccountUpdateDTO,
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
  account_number: string;
  customer_id: string;
  currency: string;
  daily_limit: bigint;
}

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily limits reset at midnight India Standard Time, returned as a UTC instant.
 */
export function startOfIstDay(now = new Date()): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(istMs / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

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
      timeout: 10000,
    });
  }

  private async lockAccounts(tx: TxClient, ids: string[]): Promise<LockedAccount[]> {
    // DEADLOCK PREVENTION: rows are always locked in ascending id order
    const sorted = [...new Set(ids)].sort();
    return tx.$queryRaw<LockedAccount[]>`
      SELECT id, balance, is_active, account_number, customer_id, currency, daily_limit
      FROM ledger_accounts
      WHERE id IN (${Prisma.join(sorted)})
      ORDER BY id ASC
      FOR UPDATE
    `;
  }

  private assertCanDebit(account: LockedAccount, actor: AuthenticatedUser): void {
    // Only the owner (or a bank administrator acting as teller) may move money out of an account.
    // A non-owner gets the same "not found" as a missing account so IDs can't be probed.
    if (account.customer_id !== actor.id && actor.role !== 'BANK_ADMIN') {
      throw new NotFoundError('Account not found');
    }
  }

  private async assertWithinDailyLimit(
    tx: TxClient,
    account: LockedAccount,
    amountInPaise: bigint
  ): Promise<void> {
    // Runs while the account row is locked, so concurrent debits are serialized and can't race past the limit
    const spent = await tx.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: {
        accountId: account.id,
        entryType: EntryType.DEBIT,
        createdAt: { gte: startOfIstDay() },
      },
    });
    const spentToday = spent._sum.amount ?? 0n;
    if (spentToday + amountInPaise > account.daily_limit) {
      const remaining = account.daily_limit - spentToday;
      throw new DailyLimitExceededError(
        `Daily outgoing limit exceeded. Remaining today: ${(remaining > 0n ? remaining : 0n).toString()} paise`
      );
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

  /**
   * Executes a transfer between two accounts using strict double-entry ledgering,
   * deterministic row-level locking, and transactional outbox event insertion.
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
      let destinationAccountId = dto.destinationAccountId;
      if (!destinationAccountId && dto.destinationAccountNumber) {
        const dest = await tx.ledgerAccount.findUnique({
          where: { accountNumber: dto.destinationAccountNumber },
          select: { id: true },
        });
        if (!dest) {
          throw new NotFoundError('Destination account not found');
        }
        destinationAccountId = dest.id;
      }
      if (!destinationAccountId) {
        throw new NotFoundError('Destination account not found');
      }

      if (sourceAccountId === destinationAccountId) {
        throw new SameAccountTransferError();
      }

      const accounts = await this.lockAccounts(tx, [sourceAccountId, destinationAccountId]);
      const sourceAccount = accounts.find((a) => a.id === sourceAccountId);
      const destAccount = accounts.find((a) => a.id === destinationAccountId);

      if (!sourceAccount) {
        throw new NotFoundError('Account not found');
      }
      this.assertCanDebit(sourceAccount, actor);
      if (!destAccount) {
        throw new NotFoundError('Destination account not found');
      }

      // Inactive account validation
      if (!sourceAccount.is_active || !destAccount.is_active) {
        throw new AccountInactiveError();
      }

      if (sourceAccount.currency !== destAccount.currency) {
        throw new CurrencyMismatchError();
      }

      // Authoritative balance check within the locked row boundary
      if (sourceAccount.balance < amountInPaise) {
        throw new InsufficientFundsError();
      }

      await this.assertWithinDailyLimit(tx, sourceAccount, amountInPaise);

      // 1. Create the Transaction record
      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          amount: amountInPaise,
          currency: sourceAccount.currency,
          sourceAccountId,
          destinationAccountId,
          initiatedBy: actor.id,
          description: description || `Transfer to account ${destAccount.account_number}`,
        },
      });

      const newSourceBalance = sourceAccount.balance - amountInPaise;
      const newDestBalance = destAccount.balance + amountInPaise;

      // 2. DOUBLE-ENTRY BOOKKEEPING:
      // Source Account is DEBITED (decrease in bank's liability to account holder)
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

      // Destination Account is CREDITED (increase in bank's liability to account holder)
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: destinationAccountId,
          entryType: EntryType.CREDIT,
          amount: amountInPaise,
          currency: destAccount.currency,
          balanceAfter: newDestBalance,
        },
      });

      // 3. Atomically update operational account balances
      await tx.ledgerAccount.update({
        where: { id: sourceAccountId },
        data: { balance: newSourceBalance },
      });

      await tx.ledgerAccount.update({
        where: { id: destinationAccountId },
        data: { balance: newDestBalance },
      });

      // 4. TRANSACTIONAL OUTBOX
      await this.stageOutboxEvent(tx, transaction.id, {
        referenceId: transaction.referenceId,
        type: transaction.type,
        amountInPaise: amountInPaise.toString(),
        currency: transaction.currency,
        sourceAccountId,
        destinationAccountId,
        sourceCustomerId: sourceAccount.customer_id,
        destinationCustomerId: destAccount.customer_id,
        initiatedBy: actor.id,
      });

      return this.toResult(transaction);
    });
  }

  /**
   * Executes a deposit into an account. Route-level authorization restricts this to BANK_ADMIN (teller).
   */
  public async executeDeposit(
    dto: DepositDTO,
    actor: AuthenticatedUser,
    txClient?: TxClient
  ): Promise<TransactionResult> {
    const { accountId, amountInPaise, description } = dto;

    if (amountInPaise <= 0n) {
      throw new InvalidAmountError();
    }

    const referenceId = dto.referenceId || this.generateReferenceId('TXN-DEP');

    return this.inTransaction(txClient, async (tx) => {
      const [account] = await this.lockAccounts(tx, [accountId]);

      if (!account) {
        throw new NotFoundError('Account not found');
      }

      if (!account.is_active) {
        throw new AccountInactiveError();
      }

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          amount: amountInPaise,
          currency: account.currency,
          destinationAccountId: accountId,
          initiatedBy: actor.id,
          description: description || 'Account cash/credit deposit',
        },
      });

      const newBalance = account.balance + amountInPaise;

      // Credit entry in ledger
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId,
          entryType: EntryType.CREDIT,
          amount: amountInPaise,
          currency: account.currency,
          balanceAfter: newBalance,
        },
      });

      await tx.ledgerAccount.update({
        where: { id: accountId },
        data: { balance: newBalance },
      });

      await this.stageOutboxEvent(tx, transaction.id, {
        referenceId: transaction.referenceId,
        type: transaction.type,
        amountInPaise: amountInPaise.toString(),
        currency: transaction.currency,
        destinationAccountId: accountId,
        destinationCustomerId: account.customer_id,
        initiatedBy: actor.id,
      });

      return this.toResult(transaction);
    });
  }

  /**
   * Executes a withdrawal from an account (owner or BANK_ADMIN only)
   */
  public async executeWithdrawal(
    dto: WithdrawDTO,
    actor: AuthenticatedUser,
    txClient?: TxClient
  ): Promise<TransactionResult> {
    const { accountId, amountInPaise, description } = dto;

    if (amountInPaise <= 0n) {
      throw new InvalidAmountError();
    }

    const referenceId = dto.referenceId || this.generateReferenceId('TXN-WTH');

    return this.inTransaction(txClient, async (tx) => {
      const [account] = await this.lockAccounts(tx, [accountId]);

      if (!account) {
        throw new NotFoundError('Account not found');
      }
      this.assertCanDebit(account, actor);

      if (!account.is_active) {
        throw new AccountInactiveError();
      }

      if (account.balance < amountInPaise) {
        throw new InsufficientFundsError();
      }

      await this.assertWithinDailyLimit(tx, account, amountInPaise);

      const transaction = await tx.transaction.create({
        data: {
          referenceId,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          amount: amountInPaise,
          currency: account.currency,
          sourceAccountId: accountId,
          initiatedBy: actor.id,
          description: description || 'Account cash withdrawal',
        },
      });

      const newBalance = account.balance - amountInPaise;

      // Debit entry in ledger
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId,
          entryType: EntryType.DEBIT,
          amount: amountInPaise,
          currency: account.currency,
          balanceAfter: newBalance,
        },
      });

      await tx.ledgerAccount.update({
        where: { id: accountId },
        data: { balance: newBalance },
      });

      await this.stageOutboxEvent(tx, transaction.id, {
        referenceId: transaction.referenceId,
        type: transaction.type,
        amountInPaise: amountInPaise.toString(),
        currency: transaction.currency,
        sourceAccountId: accountId,
        sourceCustomerId: account.customer_id,
        initiatedBy: actor.id,
      });

      return this.toResult(transaction);
    });
  }

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
  public async getTransactionHistory(
    accountId: string,
    actor: AuthenticatedUser,
    limit = 20,
    offset = 0
  ) {
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
    const existing = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!existing) {
      throw new NotFoundError('Ledger account not found');
    }
    return this.prisma.ledgerAccount.update({
      where: { id: accountId },
      data: {
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.dailyLimitPaise !== undefined && { dailyLimit: dto.dailyLimitPaise }),
      },
    });
  }

  public async getAccountSnapshot(accountId: string) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundError('Ledger account not found');
    }
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      customerId: account.customerId,
      balanceInPaise: account.balance.toString(),
      dailyLimitPaise: account.dailyLimit.toString(),
      currency: account.currency,
      isActive: account.isActive,
    };
  }
}
