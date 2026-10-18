import { PrismaClient, Prisma } from '../../generated/client';
import { AuthenticatedUser, ConflictError, HttpError, isStaff, logger } from '@banksphere/common';
import {
  TransferDTO,
  TransactionResult,
  TransactionType,
  TransactionStatus,
  LedgerAccountProvisionDTO,
  LedgerAccountUpdateDTO,
} from '../types';
import {
  NotFoundError,
  InsufficientFundsError,
  AccountInactiveError,
  SameAccountTransferError,
  InvalidAmountError,
  CurrencyMismatchError,
} from '../errors';
import {
  LedgerPolicy,
  TxClient,
  advisoryLock,
  assertWithinDailyLimits,
  audit,
  defaultLedgerPolicy,
  generateReferenceId,
  hasStepUp,
  lockAccounts,
  stepUpRequired,
  postDoubleEntry,
  stageTransactionEvent,
  toResult,
} from './ledger-core';

export { startOfIstDay } from './ledger-core';

const beneficiaryRequired = () =>
  new HttpError(422, 'BENEFICIARY_REQUIRED', 'Add this account as a beneficiary before sending money to it');

/** The one answer for "this destination can't receive money", whatever the reason */
const invalidDestination = () =>
  new HttpError(422, 'INVALID_DESTINATION', 'The destination account cannot receive this transfer');

export class LedgerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: LedgerPolicy = defaultLedgerPolicy()
  ) {}

  private inTransaction<T>(tx: TxClient | undefined, work: (tx: TxClient) => Promise<T>): Promise<T> {
    if (tx) return work(tx);
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  // ---------------------------------------------------------------------------
  // Customer transfers
  // ---------------------------------------------------------------------------

  /**
   * Transfers between two customer accounts with double-entry ledgering, deterministic row locking and a
   * transactional outbox event. Controls, in order:
   * - only the owner of the source account can move its money (no staff override);
   * - large transfers need an MFA-authenticated session (step-up);
   * - the caller's own account (status, balance, daily limits) is validated first, so nothing leaks about
   *   other accounts; every unusable destination gets the same INVALID_DESTINATION;
   * - money can go to the caller's own accounts or to an ACTIVE registered beneficiary only, and a new
   *   beneficiary is capped during its first 24 hours.
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
    if (amountInPaise >= this.policy.stepUpThreshold && !hasStepUp(actor, this.policy)) {
      throw stepUpRequired();
    }

    const referenceId = dto.referenceId || generateReferenceId('TXN-TRF');

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

      const source0 = await tx.ledgerAccount.findUnique({ where: { id: sourceAccountId }, select: { customerId: true, kind: true } });
      if (!source0 || source0.customerId !== actor.id || source0.kind !== 'CUSTOMER') {
        // Not yours (or missing): indistinguishable, so account ids can't be probed
        throw new NotFoundError('Account not found');
      }
      await advisoryLock(tx, `customer-outflow:${actor.id}`);

      const accounts = await lockAccounts(tx, destinationAccountId ? [sourceAccountId, destinationAccountId] : [sourceAccountId]);
      const sourceAccount = accounts.find((a) => a.id === sourceAccountId)!;
      const destAccount = destinationAccountId ? accounts.find((a) => a.id === destinationAccountId) : undefined;

      // 1. Everything about the caller's own account first
      if (!sourceAccount.is_active || sourceAccount.closed_at) {
        throw new AccountInactiveError('Your account is frozen or closed');
      }
      if (sourceAccount.balance < amountInPaise) {
        throw new InsufficientFundsError();
      }
      await assertWithinDailyLimits(tx, sourceAccount, amountInPaise, this.policy);

      // 2. Third-party payees must be registered before anything is revealed about them: an unregistered
      //    number gets the same answer whether it exists, is frozen or was never issued
      const ownDestination = destAccount?.customer_id === actor.id && destAccount.kind === 'CUSTOMER';
      const beneficiary =
        !ownDestination && destinationAccountId
          ? await tx.beneficiary.findUnique({ where: { customerId_accountId: { customerId: actor.id, accountId: destinationAccountId } } })
          : null;
      if (!ownDestination && (!beneficiary || beneficiary.revokedAt)) {
        throw beneficiaryRequired();
      }

      // 3. Then the destination itself, with a single uniform error
      if (
        !destAccount ||
        destAccount.kind !== 'CUSTOMER' ||
        !destAccount.is_active ||
        destAccount.closed_at ||
        destAccount.currency !== sourceAccount.currency
      ) {
        if (destAccount && destAccount.kind === 'CUSTOMER' && destAccount.currency !== sourceAccount.currency && destAccount.customer_id === actor.id) {
          throw new CurrencyMismatchError();
        }
        throw invalidDestination();
      }

      // 4. Payee controls for third-party transfers
      if (!ownDestination) {
        await this.assertBeneficiaryAllows(tx, actor.id, destAccount.id, amountInPaise);
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

      await postDoubleEntry(tx, { transactionId: transaction.id, debit: sourceAccount, credit: destAccount, amount: amountInPaise });

      await stageTransactionEvent(tx, transaction.id, {
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

      return toResult(transaction);
    });
  }

  private async assertBeneficiaryAllows(tx: TxClient, customerId: string, accountId: string, amount: bigint): Promise<void> {
    const beneficiary = await tx.beneficiary.findUnique({ where: { customerId_accountId: { customerId, accountId } } });
    const now = Date.now();
    if (!beneficiary || beneficiary.revokedAt) {
      throw beneficiaryRequired();
    }
    if (beneficiary.activatesAt.getTime() > now) {
      throw new HttpError(422, 'BENEFICIARY_COOLING_OFF', `This beneficiary becomes active at ${beneficiary.activatesAt.toISOString()}`);
    }
    if (now - beneficiary.activatesAt.getTime() < 24 * 3600_000) {
      const sent = await tx.transaction.aggregate({
        _sum: { amount: true },
        where: {
          type: TransactionType.TRANSFER,
          initiatedBy: customerId,
          destinationAccountId: accountId,
          createdAt: { gte: beneficiary.activatesAt },
        },
      });
      if ((sent._sum.amount ?? 0n) + amount > this.policy.newBeneficiaryLimit) {
        throw new HttpError(
          422,
          'NEW_BENEFICIARY_LIMIT',
          `A new beneficiary can receive at most ${this.policy.newBeneficiaryLimit.toString()} paise in its first 24 hours`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async getReadableAccount(accountId: string, actor: AuthenticatedUser, action: string) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account || (account.customerId !== actor.id && !isStaff(actor))) {
      throw new NotFoundError('Account not found');
    }
    if (account.customerId !== actor.id) {
      // Staff access to customer data is always recorded
      await audit(this.prisma, actor.id, action, accountId, { role: actor.role });
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
    const account = await this.getReadableAccount(accountId, actor, 'STAFF_VIEW_BALANCE');
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
    await this.getReadableAccount(accountId, actor, 'STAFF_VIEW_HISTORY');

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
        controlVersion: 0,
      },
    });
  }

  /**
   * Applies account-service's control state only if `version` is newer than what the ledger already has,
   * so a delayed or stale writer (e.g. the reconciler) can never undo a newer freeze or limit change.
   * Returns whether the update was applied.
   */
  public async updateAccount(accountId: string, dto: LedgerAccountUpdateDTO): Promise<{ applied: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const [account] = await lockAccounts(tx, [accountId]);
      if (!account || account.kind !== 'CUSTOMER') throw new NotFoundError('Ledger account not found');
      if (account.closed_at) throw new ConflictError('Ledger account is closed');
      const result = await tx.ledgerAccount.updateMany({
        where: { id: accountId, controlVersion: { lt: dto.version } },
        data: {
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.dailyLimitPaise !== undefined && { dailyLimit: dto.dailyLimitPaise }),
          controlVersion: dto.version,
        },
      });
      return { applied: result.count === 1 };
    });
  }

  /**
   * Closes an account. The ledger is the authority: the zero-balance check and the close happen under
   * the row lock, so a transfer can't land between "balance is 0" and "closed". Idempotent.
   */
  public async closeAccount(accountId: string, version: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [account] = await lockAccounts(tx, [accountId]);
      if (!account || account.kind !== 'CUSTOMER') throw new NotFoundError('Ledger account not found');
      if (account.closed_at) return;
      if (account.balance !== 0n) {
        throw new HttpError(409, 'BALANCE_NOT_ZERO', 'Account balance must be zero before the account can be closed');
      }
      await tx.ledgerAccount.update({ where: { id: accountId }, data: { isActive: false, closedAt: new Date(), controlVersion: version } });
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
    controlVersion: number;
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
      controlVersion: account.controlVersion,
    };
  }

  public async getAccountSnapshot(accountId: string) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account || account.kind !== 'CUSTOMER') {
      throw new NotFoundError('Ledger account not found');
    }
    return this.snapshot(account);
  }

  public async getAccountSnapshots(ids: string[]) {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { id: { in: ids }, kind: 'CUSTOMER' } });
    return accounts.map((a) => this.snapshot(a));
  }

  // ---------------------------------------------------------------------------
  // Integrity
  // ---------------------------------------------------------------------------

  /**
   * Ledger invariants (any violation means tampering or a bug and is logged as an alert):
   * 1. every account's balance equals its entries (credit-normal for customers, debit-normal for drawers);
   * 2. every transaction's debits equal its credits;
   * 3. zero-sum: total owed to customers equals total cash recorded in teller drawers.
   */
  public async reconcileBalances(): Promise<{ checked: number; mismatches: string[]; unbalancedTransactions: number; zeroSumDelta: string }> {
    // One REPEATABLE READ snapshot, so all three checks see the same instant even while money moves
    return this.prisma.$transaction(
      async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a.id
      FROM ledger_accounts a
      LEFT JOIN (
        SELECT account_id,
               SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS net_credit
        FROM ledger_entries GROUP BY account_id
      ) e ON e.account_id = a.id
      WHERE a.balance <> CASE WHEN a.kind = 'CUSTOMER' THEN COALESCE(e.net_credit, 0) ELSE -COALESCE(e.net_credit, 0) END
    `;
    const [{ unbalanced }] = await tx.$queryRaw<Array<{ unbalanced: bigint }>>`
      SELECT count(*)::bigint AS unbalanced FROM (
        SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
        HAVING SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) <> SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)
      ) x
    `;
    const [{ customers, drawers, count }] = await tx.$queryRaw<Array<{ customers: bigint | null; drawers: bigint | null; count: bigint }>>`
      SELECT SUM(CASE WHEN kind = 'CUSTOMER' THEN balance ELSE 0 END)::bigint AS customers,
             SUM(CASE WHEN kind <> 'CUSTOMER' THEN balance ELSE 0 END)::bigint AS drawers,
             count(*)::bigint AS count
      FROM ledger_accounts
    `;
    const mismatches = rows.map((r) => r.id);
    const zeroSumDelta = (customers ?? 0n) - (drawers ?? 0n);
    if (mismatches.length || unbalanced > 0n || zeroSumDelta !== 0n) {
      logger.error(
        { mismatches, unbalancedTransactions: Number(unbalanced), zeroSumDelta: zeroSumDelta.toString(), alert: 'LEDGER_RECONCILIATION_FAILED' },
        'Ledger invariants violated'
      );
    }
    return { checked: Number(count), mismatches, unbalancedTransactions: Number(unbalanced), zeroSumDelta: zeroSumDelta.toString() };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 }
    );
  }

}
