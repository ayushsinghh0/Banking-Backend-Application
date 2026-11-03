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
import { StaffAccessAction } from '../types';
import { AccountListCache } from './account-cache';

export const DEFAULT_DAILY_LIMIT_PAISE = 10000000n; // ₹1,00,000.00
export const MAX_CUSTOMER_DAILY_LIMIT_PAISE = BigInt(
  process.env.MAX_CUSTOMER_DAILY_LIMIT_PAISE || '10000000'
);
export const MAX_ACCOUNTS_PER_CUSTOMER = Number(process.env.MAX_ACCOUNTS_PER_CUSTOMER || 5);
const ACCOUNT_NUMBER_ATTEMPTS = 8;

/** The ledger already holds this account number (e.g. an orphan of a failed opening): draw another one */
class AccountNumberTakenError extends Error {}

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
    private readonly customerClient: CustomerClient,
    private readonly listCache: AccountListCache = new AccountListCache()
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
    for (let attempt = 0; attempt < ACCOUNT_NUMBER_ATTEMPTS && !account; attempt++) {
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
            try {
              await this.ledgerClient.provisionAccount({
                id: created.id,
                accountNumber: created.accountNumber,
                customerId: created.customerId,
                currency: created.currency,
                dailyLimitPaise: created.dailyLimit.toString(),
                isActive: false,
              });
            } catch (err) {
              // 409: the ledger already has this number (an orphan from an opening whose commit failed).
              // The id is fresh on every attempt, so this can only be the number.
              if (err instanceof HttpError && err.statusCode === 409) throw new AccountNumberTakenError();
              throw err;
            }

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
        // Number already taken, here (unique violation) or in the ledger: retry with a fresh number
        if (err?.code === 'P2002' || err instanceof AccountNumberTakenError) continue;
        throw err;
      }
    }

    if (!account) {
      throw new ConflictError('Failed to allocate unique account number. Please retry.');
    }
    // Committed: the customer's cached account list is stale
    await this.listCache.changed(account.customerId);

    // The account is committed: the client must get it back now. An error here would invite a retry that
    // opens a second account, so a failed activation is left to reconcileWithLedger() (the ledger account
    // stays INACTIVE, i.e. safe, until then) and alerted.
    try {
      const { applied } = await this.ledgerClient.updateAccount(account.id, {
        isActive: true,
        dailyLimitPaise: account.dailyLimit.toString(),
        version: account.version,
      });
      if (!applied) {
        // The ledger already holds a newer control state for this account (e.g. an immediate freeze): it stands
        logger.error({ accountId: account.id, version: account.version, alert: 'ACCOUNT_LEDGER_ACTIVATION_NOT_APPLIED' }, 'Ledger did not apply the activation of a new account');
      }
    } catch (err) {
      logger.error({ err, accountId: account.id, alert: 'ACCOUNT_LEDGER_ACTIVATION_FAILED' }, 'New account committed but not activated in the ledger; the reconciler will retry');
    }
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

  /** Account details for the API: a staff read of someone else's account is recorded first */
  public async viewAccount(accountId: string, actor: AuthenticatedUser): Promise<BankAccount> {
    const account = await this.getAccountById(accountId, actor);
    await this.logStaffAccess(actor, account.customerId, account.id, 'VIEW_ACCOUNT');
    return account;
  }

  /** Staff may list any customer's accounts (recorded); customers always get their own */
  public async listAccounts(actor: AuthenticatedUser, customerId?: string): Promise<BankAccount[]> {
    const targetCustomerId = isStaff(actor) && customerId ? customerId : actor.id;
    const accounts = await this.getAccountsByCustomerId(targetCustomerId);
    await this.logStaffAccess(actor, targetCustomerId, null, 'LIST_ACCOUNTS');
    return accounts;
  }

  /** Staff lookup of an account by its number (e.g. a teller identifying a customer's account) */
  public async lookupByAccountNumber(accountNumber: string, actor: AuthenticatedUser): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.findUnique({ where: { accountNumber } });
    if (!account) throw new NotFoundError('Bank account not found');
    await this.logStaffAccess(actor, account.customerId, account.id, 'LOOKUP_ACCOUNT');
    return account;
  }

  /**
   * Who on staff read which customer's accounts (append-only). Written before the data is returned, so
   * there is no read without a record. A staff member's own accounts are a customer read.
   */
  private async logStaffAccess(
    actor: AuthenticatedUser,
    customerId: string,
    accountId: string | null,
    action: StaffAccessAction
  ): Promise<void> {
    if (!isStaff(actor) || customerId === actor.id) return;
    await this.prisma.staffAccessLog.create({
      data: { actorId: actor.id, actorRole: actor.role, customerId, accountId, action },
    });
  }

  /**
   * Lists all bank accounts owned by a specific customer (cached; see AccountListCache). Callers authorize.
   */
  public async getAccountsByCustomerId(customerId: string): Promise<BankAccount[]> {
    return this.listCache.list(customerId, () =>
      this.prisma.bankAccount.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
      })
    );
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
   *
   * An administrator freezing an account that is already frozen (e.g. by its owner) places a bank hold:
   * nothing changes for the customer, but lifting the freeze then needs a different administrator.
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
    const isAdmin = this.actsAsAdmin(actor, account);
    const bankHold = account.status === status && status === AccountStatus.FROZEN && isAdmin;
    if (account.status === status && (!bankHold || (await this.staffHolders(account)).has(actor.id))) {
      return account;
    }

    const ownerFreeze = account.customerId === actor.id && status === AccountStatus.FROZEN;
    if (!isAdmin && !ownerFreeze) {
      throw new ForbiddenError(
        'Only bank administrators can unfreeze or close accounts; customers may only freeze their own account'
      );
    }

    // Dual control: an account frozen (or held) by a staff member can only be unfrozen by a different one
    if (status === AccountStatus.ACTIVE && account.status === AccountStatus.FROZEN) {
      if ((await this.staffHolders(account)).has(actor.id)) {
        throw new ForbiddenError('An account you froze must be unfrozen by a different administrator');
      }
    }

    // A unique version for this change, reserved atomically against the version we read: two concurrent
    // writers can never push the same version to the ledger
    const version = await this.reserveVersion(account, account.version);

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
      if (bankHold) {
        // Same status, so no customer notice; the hold only changes who may lift the freeze
        await this.audit(tx, actor.id, 'ACCOUNT_BANK_HOLD', accountId, { status });
      } else {
        await this.stageEvent(tx, 'account.status.changed.v1', accountId, {
          accountId,
          customerId: account.customerId,
          previousStatus: account.status,
          status,
          changedBy: actor.id,
        });
        await this.audit(tx, actor.id, 'ACCOUNT_STATUS_CHANGED', accountId, { from: account.status, to: status });
      }
      return tx.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
    });
    await this.listCache.changed(account.customerId);

    // Permissive change: only after our own commit
    if (status === AccountStatus.ACTIVE) {
      await this.pushToLedger(accountId, { isActive: true, dailyLimitPaise: updated.dailyLimit.toString(), version });
    }

    return updated;
  }

  /**
   * Staff who froze the account, or placed a hold on it, since it was last frozen: the walk back stops at
   * the status change into FROZEN (the newest ACCOUNT_STATUS_CHANGED row of a frozen account). The owner
   * is not a holder: a customer's own freeze never stops an administrator from lifting it.
   */
  private async staffHolders(account: BankAccount): Promise<Set<string>> {
    const history = await this.prisma.auditLog.findMany({
      where: { targetId: account.id, action: { in: ['ACCOUNT_STATUS_CHANGED', 'ACCOUNT_BANK_HOLD'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { actorId: true, action: true },
    });
    const holders = new Set<string>();
    for (const row of history) {
      holders.add(row.actorId);
      if (row.action === 'ACCOUNT_STATUS_CHANGED') break;
    }
    holders.delete(account.customerId);
    return holders;
  }

  /**
   * Bumps the account's control version iff it is still `expected`; returns the new version. The version is
   * part of the account's view, so the owner's cached list is invalidated once it has committed.
   */
  private async reserveVersion(account: { id: string; customerId: string }, expected: number): Promise<number> {
    const result = await this.prisma.bankAccount.updateMany({
      where: { id: account.id, version: expected },
      data: { version: { increment: 1 } },
    });
    if (result.count !== 1) throw new ConflictError('Account changed concurrently, please retry');
    await this.listCache.changed(account.customerId);
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
   * Changes the per-day outgoing limit enforced by the ledger. A limit set by an administrator (on someone
   * else's account, at any positive value) becomes the account's bank ceiling. The owner may always lower
   * the limit, but raise it only up to the customer cap and that ceiling, so a reduction imposed by the
   * bank can't simply be undone.
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
    if (dailyLimit <= 0n) {
      throw new BadRequestError('Daily limit must be a positive amount in paise');
    }
    if (!isAdmin && dailyLimit > account.dailyLimit) {
      this.assertDailyLimitAllowed(dailyLimit, false);
      if (account.bankLimitCeiling !== null && dailyLimit > account.bankLimitCeiling) {
        throw new ForbiddenError(
          `This account's daily limit is capped by the bank at ${account.bankLimitCeiling.toString()} paise; raising it further requires bank approval`
        );
      }
    }
    const setsCeiling = isAdmin && account.bankLimitCeiling !== dailyLimit;
    if (dailyLimit === account.dailyLimit && !setsCeiling) return account;

    const version = await this.reserveVersion(account, account.version);
    const ledgerState = { isActive: account.status === AccountStatus.ACTIVE, dailyLimitPaise: dailyLimit.toString(), version };
    const lowering = dailyLimit < account.dailyLimit;
    if (lowering) {
      await this.pushToLedger(accountId, ledgerState);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const cas = await tx.bankAccount.updateMany({
        where: { id: accountId, version },
        data: { dailyLimit, ...(isAdmin && { bankLimitCeiling: dailyLimit }) },
      });
      if (cas.count !== 1) throw new ConflictError('Account changed concurrently, please retry');
      const result = await tx.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
      await this.audit(tx, actor.id, 'DAILY_LIMIT_CHANGED', accountId, {
        from: account.dailyLimit.toString(),
        to: dailyLimit.toString(),
        ...(setsCeiling && {
          bankLimitCeiling: { from: account.bankLimitCeiling?.toString() ?? null, to: dailyLimit.toString() },
        }),
      });
      return result;
    });
    await this.listCache.changed(account.customerId);
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
                  ledger.controlVersion < account.version ? account.version : await this.reserveVersion(account, account.version);
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
