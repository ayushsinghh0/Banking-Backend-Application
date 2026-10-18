import crypto from 'crypto';
import { PrismaClient, Prisma, BankAccount, AccountType, AccountStatus } from '../../generated/client';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  AuthenticatedUser,
  HttpError,
  isStaff,
  logger,
} from '@banksphere/common';
import { AccountNumberGenerator } from '../utils/account-number.generator';
import { LedgerClient } from '../clients/ledger.client';
import { CustomerClient } from '../clients/customer.client';

export const DEFAULT_DAILY_LIMIT_PAISE = 10000000n; // ₹1,00,000.00
export const MAX_CUSTOMER_DAILY_LIMIT_PAISE = BigInt(
  process.env.MAX_CUSTOMER_DAILY_LIMIT_PAISE || '10000000'
);
export const MAX_ACCOUNTS_PER_CUSTOMER = Number(process.env.MAX_ACCOUNTS_PER_CUSTOMER || 5);

export interface CreateAccountDTO {
  customerId: string;
  accountType?: AccountType;
  currency?: string;
  dailyLimitPaise?: bigint;
}

export class AccountService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledgerClient: LedgerClient,
    private readonly customerClient: CustomerClient
  ) {}

  /**
   * Provisions a new bank account, registers it in the ledger, and publishes 'account.created.v1'
   */
  public async createAccount(dto: CreateAccountDTO, actor: AuthenticatedUser): Promise<BankAccount> {
    const dailyLimit = dto.dailyLimitPaise ?? DEFAULT_DAILY_LIMIT_PAISE;
    // Accounts are always opened by their owner, so the customer cap applies
    this.assertDailyLimitAllowed(dailyLimit, false);

    const currency = dto.currency || 'INR';
    if (currency !== 'INR') {
      // The ledger has no FX support; mixed-currency transfers would silently mis-value money
      throw new BadRequestError('Only INR accounts are supported');
    }

    // Regulatory gate: no account without a completed KYC review
    const kycStatus = await this.customerClient.getKycStatus(dto.customerId);
    if (kycStatus !== 'VERIFIED') {
      throw new HttpError(
        403,
        'KYC_NOT_VERIFIED',
        'Your identity verification (KYC) must be approved before you can open an account'
      );
    }

    let account: BankAccount | null = null;
    for (let attempt = 0; attempt < 5 && !account; attempt++) {
      const accountNumber = AccountNumberGenerator.generate();
      try {
        account = await this.prisma.$transaction(
          async (tx) => {
            // Serialise account opening per customer so concurrent requests can't exceed the cap
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'open-account:' + dto.customerId}, 0))::text`;
            const existingCount = await tx.bankAccount.count({
              where: { customerId: dto.customerId, status: { not: AccountStatus.CLOSED } },
            });
            if (existingCount >= MAX_ACCOUNTS_PER_CUSTOMER) {
              throw new ConflictError(`A customer may hold at most ${MAX_ACCOUNTS_PER_CUSTOMER} open accounts`);
            }

            const created = await tx.bankAccount.create({
              data: {
                id: crypto.randomUUID(),
                accountNumber,
                customerId: dto.customerId,
                accountType: dto.accountType || AccountType.SAVINGS,
                currency,
                dailyLimit,
                status: AccountStatus.ACTIVE,
              },
            });

            // Provisioned INACTIVE inside our transaction: if our commit then fails, the orphan ledger
            // account can't send or receive money. It is activated only after the commit below.
            await this.ledgerClient.provisionAccount({
              id: created.id,
              accountNumber: created.accountNumber,
              customerId: created.customerId,
              currency: created.currency,
              dailyLimitPaise: created.dailyLimit.toString(),
              isActive: false,
            });

            await this.stageEvent(tx, 'account.created.v1', created.id, {
              accountId: created.id,
              accountNumber: created.accountNumber,
              customerId: created.customerId,
              accountType: created.accountType,
              currency: created.currency,
              status: created.status,
            });

            return created;
          },
          { timeout: 15000 }
        );
      } catch (err: any) {
        // Unique violation on account_number: retry with a fresh number
        if (err?.code === 'P2002') continue;
        throw err;
      }
    }

    if (!account) {
      throw new ConflictError('Failed to allocate unique account number. Please retry.');
    }

    // If this fails the account stays unusable until reconcileWithLedger() activates it
    await this.ledgerClient.updateAccount(account.id, {
      isActive: true,
      dailyLimitPaise: account.dailyLimit.toString(),
      version: account.version,
    });
    return account;
  }

  /**
   * Retrieves account details with strict ownership verification
   */
  public async getAccountById(accountId: string, actor: AuthenticatedUser): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.findUnique({
      where: { id: accountId },
    });

    // Same response for "missing" and "not yours" so account IDs can't be probed
    if (!account || (!isStaff(actor) && account.customerId !== actor.id)) {
      throw new NotFoundError('Bank account not found');
    }

    return account;
  }

  /**
   * Lists all bank accounts owned by a specific customer
   */
  public async getAccountsByCustomerId(customerId: string): Promise<BankAccount[]> {
    return this.prisma.bankAccount.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin powers apply only to other people's accounts: on their own account a staff member has
   * exactly the rights of a customer.
   */
  private actsAsAdmin(actor: AuthenticatedUser, account: BankAccount): boolean {
    return actor.role === 'BANK_ADMIN' && account.customerId !== actor.id;
  }

  /**
   * Updates an account's lifecycle status.
   * Customers may only freeze their own account (e.g. lost card). Unfreezing and closing are BANK_ADMIN
   * decisions on someone else's account; closing requires a zero ledger balance.
   *
   * Write ordering keeps the two stores safe if one write fails: restrictive changes (freeze, close) hit
   * the ledger first, permissive ones (unfreeze) commit here first. A failure therefore leaves money
   * MORE restricted, never less, and reconcileWithLedger() repairs the difference.
   */
  public async updateAccountStatus(
    accountId: string,
    status: AccountStatus,
    actor: AuthenticatedUser
  ): Promise<BankAccount> {
    const account = await this.getAccountById(accountId, actor);

    if (account.status === AccountStatus.CLOSED) {
      throw new ConflictError('Cannot alter status of an already permanently closed account');
    }
    if (account.status === status) {
      return account;
    }

    const isAdmin = this.actsAsAdmin(actor, account);
    const ownerFreeze = account.customerId === actor.id && status === AccountStatus.FROZEN;
    if (!isAdmin && !ownerFreeze) {
      throw new ForbiddenError(
        'Only bank administrators can unfreeze or close accounts; customers may only freeze their own account'
      );
    }

    // Dual control: an account frozen by a staff member can only be unfrozen by a different one
    if (status === AccountStatus.ACTIVE && account.status === AccountStatus.FROZEN) {
      const lastFreeze = await this.prisma.auditLog.findFirst({
        where: { targetId: accountId, action: 'ACCOUNT_STATUS_CHANGED' },
        orderBy: { createdAt: 'desc' },
      });
      if (lastFreeze && lastFreeze.actorId === actor.id && lastFreeze.actorId !== account.customerId) {
        throw new ForbiddenError('An account you froze must be unfrozen by a different administrator');
      }
    }

    // A unique version for this change, reserved atomically against the version we read: two concurrent
    // writers can never push the same version to the ledger
    const version = await this.reserveVersion(accountId, account.version);

    // Restrictive changes: ledger first (it is the authority on whether money can move / balance is 0)
    if (status === AccountStatus.CLOSED) {
      await this.ledgerClient.closeAccount(accountId, version);
    } else if (status === AccountStatus.FROZEN) {
      await this.pushToLedger(accountId, { isActive: false, dailyLimitPaise: account.dailyLimit.toString(), version });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bankAccount.updateMany({
        where: { id: accountId, version },
        data: { status },
      });
      if (result.count !== 1) {
        throw new ConflictError('Account status changed concurrently, please retry');
      }
      await this.stageEvent(tx, 'account.status.changed.v1', accountId, {
        accountId,
        customerId: account.customerId,
        previousStatus: account.status,
        status,
        changedBy: actor.id,
      });
      await this.audit(tx, actor.id, 'ACCOUNT_STATUS_CHANGED', accountId, { from: account.status, to: status });
      return tx.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
    });

    // Permissive change: only after our own commit
    if (status === AccountStatus.ACTIVE) {
      await this.pushToLedger(accountId, { isActive: true, dailyLimitPaise: updated.dailyLimit.toString(), version });
    }

    return updated;
  }

  /** Bumps the account's control version iff it is still `expected`; returns the new version */
  private async reserveVersion(accountId: string, expected: number): Promise<number> {
    const result = await this.prisma.bankAccount.updateMany({
      where: { id: accountId, version: expected },
      data: { version: { increment: 1 } },
    });
    if (result.count !== 1) throw new ConflictError('Account changed concurrently, please retry');
    return expected + 1;
  }

  /** A push the ledger did not apply means it already holds a newer state: never treat that as success */
  private async pushToLedger(accountId: string, update: { isActive: boolean; dailyLimitPaise: string; version: number }) {
    const { applied } = await this.ledgerClient.updateAccount(accountId, update);
    if (!applied) {
      logger.error({ accountId, version: update.version, alert: 'ACCOUNT_LEDGER_PUSH_REJECTED' }, 'Ledger refused an account control update');
      throw new ConflictError('Account changed concurrently, please retry');
    }
  }

  /**
   * Changes the per-day outgoing limit enforced by the ledger. Customers can set any value up to the
   * customer cap; only an administrator (on someone else's account) can go above it.
   */
  public async updateDailyLimit(
    accountId: string,
    dailyLimit: bigint,
    actor: AuthenticatedUser
  ): Promise<BankAccount> {
    const account = await this.getAccountById(accountId, actor);
    const isAdmin = this.actsAsAdmin(actor, account);
    if (!isAdmin && account.customerId !== actor.id) {
      throw new ForbiddenError('Only the account owner or a bank administrator can change limits');
    }
    if (account.status === AccountStatus.CLOSED) {
      throw new ConflictError('Cannot change limits on a closed account');
    }
    this.assertDailyLimitAllowed(dailyLimit, isAdmin);
    if (dailyLimit === account.dailyLimit) return account;

    const version = await this.reserveVersion(accountId, account.version);
    const ledgerState = { isActive: account.status === AccountStatus.ACTIVE, dailyLimitPaise: dailyLimit.toString(), version };
    const lowering = dailyLimit < account.dailyLimit;
    if (lowering) {
      await this.pushToLedger(accountId, ledgerState);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const cas = await tx.bankAccount.updateMany({ where: { id: accountId, version }, data: { dailyLimit } });
      if (cas.count !== 1) throw new ConflictError('Account changed concurrently, please retry');
      const result = await tx.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
      await this.audit(tx, actor.id, 'DAILY_LIMIT_CHANGED', accountId, {
        from: account.dailyLimit.toString(),
        to: dailyLimit.toString(),
      });
      return result;
    });
    if (!lowering) {
      await this.pushToLedger(accountId, ledgerState);
    }
    return updated;
  }

  private assertDailyLimitAllowed(dailyLimit: bigint, isAdmin: boolean): void {
    if (dailyLimit <= 0n) {
      throw new BadRequestError('Daily limit must be a positive amount in paise');
    }
    if (!isAdmin && dailyLimit > MAX_CUSTOMER_DAILY_LIMIT_PAISE) {
      throw new ForbiddenError(
        `Daily limits above ${MAX_CUSTOMER_DAILY_LIMIT_PAISE.toString()} paise require bank approval`
      );
    }
  }

  /**
   * Re-aligns the ledger with this service's account state (status and daily limit), repairing any
   * divergence left by a failed cross-service write. Run periodically. Every push carries the account's
   * version, and the ledger only applies versions newer than its own, so a stale snapshot read here can
   * never undo a newer freeze or limit change made concurrently.
   */
  public async reconcileWithLedger(batchSize = 200): Promise<{ checked: number; repaired: number }> {
    let checked = 0;
    let repaired = 0;
    let cursor: string | undefined;
    for (;;) {
      const accounts = await this.prisma.bankAccount.findMany({
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!accounts.length) break;
      cursor = accounts[accounts.length - 1].id;
      const snapshots = new Map((await this.ledgerClient.getAccounts(accounts.map((a) => a.id))).map((s) => [s.id, s]));

      for (const account of accounts) {
        checked++;
        const ledger = snapshots.get(account.id);
        if (!ledger) {
          logger.error({ accountId: account.id, alert: 'LEDGER_ACCOUNT_MISSING' }, 'Account has no ledger account');
          continue;
        }
        try {
          if (ledger.controlVersion > account.version) {
            // The ledger saw a newer (restrictive-first) change whose local commit failed: needs a human
            logger.error({ accountId: account.id, alert: 'ACCOUNT_LEDGER_VERSION_AHEAD' }, 'Ledger is ahead of the account record');
          } else if (account.status === AccountStatus.CLOSED && !ledger.closed) {
            await this.ledgerClient.closeAccount(account.id, account.version);
            repaired++;
          } else if (account.status !== AccountStatus.CLOSED) {
            const wantActive = account.status === AccountStatus.ACTIVE;
            const wantLimit = account.dailyLimit.toString();
            if (ledger.closed) {
              logger.error({ accountId: account.id, alert: 'ACCOUNT_LEDGER_CLOSED_MISMATCH' }, 'Ledger closed but account is not');
            } else if (ledger.isActive !== wantActive || ledger.dailyLimitPaise !== wantLimit) {
              const ledgerLooser = (ledger.isActive && !wantActive) || BigInt(ledger.dailyLimitPaise) > account.dailyLimit;
              if (ledger.controlVersion === account.version && !ledgerLooser) {
                // Same version, ledger stricter: a restrictive change reached the ledger but not this record.
                // Never loosen money controls automatically: a person decides.
                logger.error({ accountId: account.id, alert: 'ACCOUNT_LEDGER_DIVERGED' }, 'Ledger is stricter than the account record at the same version');
              } else {
                // The ledger allows more than it should (or is simply behind): push our state with a fresh version
                const version =
                  ledger.controlVersion < account.version ? account.version : await this.reserveVersion(account.id, account.version);
                const { applied } = await this.ledgerClient.updateAccount(account.id, { isActive: wantActive, dailyLimitPaise: wantLimit, version });
                if (applied) repaired++;
                else logger.error({ accountId: account.id, alert: 'ACCOUNT_LEDGER_PUSH_REJECTED' }, 'Ledger refused the reconciliation push');
              }
            }
          }
        } catch (err) {
          logger.error({ err, accountId: account.id }, 'Ledger reconciliation repair failed');
        }
      }
      if (accounts.length < batchSize) break;
    }
    if (repaired) logger.warn({ repaired }, 'Repaired account/ledger divergence');
    return { checked, repaired };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorId: string,
    action: string,
    targetId: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    await tx.auditLog.create({ data: { actorId, action, targetId, details: details as Prisma.InputJsonValue | undefined } });
  }

  private async stageEvent(
    tx: Prisma.TransactionClient,
    eventType: string,
    aggregateId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    // TRANSACTIONAL OUTBOX: committed together with the account change, relayed to Kafka afterwards
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'ACCOUNT',
        aggregateId,
        eventType,
        payload: {
          eventId: crypto.randomUUID(),
          eventType,
          timestamp: new Date().toISOString(),
          ...data,
        } as Prisma.InputJsonValue,
      },
    });
  }
}
