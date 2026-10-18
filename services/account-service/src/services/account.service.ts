import crypto from 'crypto';
import { PrismaClient, BankAccount, AccountType, AccountStatus } from '../../generated/client';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  AuthenticatedUser,
  isStaff,
  logger,
} from '@banksphere/common';
import { AccountNumberGenerator } from '../utils/account-number.generator';
import { LedgerClient } from '../clients/ledger.client';

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

export interface KafkaPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

export class AccountService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledgerClient: LedgerClient,
    private readonly kafkaPublisher?: KafkaPublisher | null
  ) {}

  /**
   * Provisions a new bank account, registers it in the ledger, and publishes 'account.created.v1'
   */
  public async createAccount(dto: CreateAccountDTO, actor: AuthenticatedUser): Promise<BankAccount> {
    const dailyLimit = dto.dailyLimitPaise ?? DEFAULT_DAILY_LIMIT_PAISE;
    this.assertDailyLimitAllowed(dailyLimit, actor);

    const currency = dto.currency || 'INR';
    if (currency !== 'INR') {
      // The ledger has no FX support; mixed-currency transfers would silently mis-value money
      throw new BadRequestError('Only INR accounts are supported');
    }

    const existingCount = await this.prisma.bankAccount.count({
      where: { customerId: dto.customerId, status: { not: AccountStatus.CLOSED } },
    });
    if (existingCount >= MAX_ACCOUNTS_PER_CUSTOMER) {
      throw new ConflictError(`A customer may hold at most ${MAX_ACCOUNTS_PER_CUSTOMER} open accounts`);
    }

    let account: BankAccount | null = null;
    for (let attempt = 0; attempt < 5 && !account; attempt++) {
      const accountNumber = AccountNumberGenerator.generate();
      try {
        account = await this.prisma.$transaction(
          async (tx) => {
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

            // Ledger provisioning happens inside the DB transaction: if it fails, the account row is rolled back
            await this.ledgerClient.provisionAccount({
              id: created.id,
              accountNumber: created.accountNumber,
              customerId: created.customerId,
              currency: created.currency,
              dailyLimitPaise: created.dailyLimit.toString(),
              isActive: true,
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

    await this.publish('account.created.v1', account.id, {
      accountId: account.id,
      accountNumber: account.accountNumber,
      customerId: account.customerId,
      accountType: account.accountType,
      currency: account.currency,
      status: account.status,
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
   * Updates an account's lifecycle status.
   * Customers may only freeze their own account (e.g. lost card). Unfreezing and closing
   * are BANK_ADMIN decisions, and closing requires a zero ledger balance.
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

    const isAdmin = actor.role === 'BANK_ADMIN';
    const customerSelfFreeze =
      actor.role === 'CUSTOMER' && status === AccountStatus.FROZEN;

    if (!isAdmin && !customerSelfFreeze) {
      throw new ForbiddenError(
        'Only bank administrators can unfreeze or close accounts; customers may only freeze their own account'
      );
    }

    if (status === AccountStatus.CLOSED) {
      const ledger = await this.ledgerClient.getAccount(accountId);
      if (BigInt(ledger.balanceInPaise) !== 0n) {
        throw new ConflictError('Account balance must be zero before the account can be closed');
      }
    }

    const updated = await this.prisma.$transaction(
      async (tx) => {
        // Conditional update guards against a concurrent status change between read and write
        const result = await tx.bankAccount.updateMany({
          where: { id: accountId, status: account.status },
          data: { status },
        });
        if (result.count !== 1) {
          throw new ConflictError('Account status changed concurrently, please retry');
        }

        await this.ledgerClient.updateAccount(accountId, {
          isActive: status === AccountStatus.ACTIVE,
        });

        return tx.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
      },
      { timeout: 15000 }
    );

    await this.publish('account.status.changed.v1', updated.id, {
      accountId: updated.id,
      customerId: updated.customerId,
      previousStatus: account.status,
      status: updated.status,
      changedBy: actor.id,
    });

    return updated;
  }

  /**
   * Changes the per-day outgoing limit enforced by the ledger
   */
  public async updateDailyLimit(
    accountId: string,
    dailyLimit: bigint,
    actor: AuthenticatedUser
  ): Promise<BankAccount> {
    const account = await this.getAccountById(accountId, actor);
    if (actor.role === 'SUPPORT') {
      throw new ForbiddenError('Support staff cannot change account limits');
    }
    if (account.status === AccountStatus.CLOSED) {
      throw new ConflictError('Cannot change limits on a closed account');
    }
    this.assertDailyLimitAllowed(dailyLimit, actor);

    return this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.bankAccount.update({
          where: { id: accountId },
          data: { dailyLimit },
        });
        await this.ledgerClient.updateAccount(accountId, { dailyLimitPaise: dailyLimit.toString() });
        return updated;
      },
      { timeout: 15000 }
    );
  }

  private assertDailyLimitAllowed(dailyLimit: bigint, actor: AuthenticatedUser): void {
    if (dailyLimit <= 0n) {
      throw new BadRequestError('Daily limit must be a positive amount in paise');
    }
    if (actor.role !== 'BANK_ADMIN' && dailyLimit > MAX_CUSTOMER_DAILY_LIMIT_PAISE) {
      throw new ForbiddenError(
        `Daily limits above ${MAX_CUSTOMER_DAILY_LIMIT_PAISE.toString()} paise require bank approval`
      );
    }
  }

  private async publish(eventType: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.kafkaPublisher) return;
    try {
      await this.kafkaPublisher.publish(eventType, key, {
        eventId: crypto.randomUUID(),
        eventType,
        timestamp: new Date().toISOString(),
        ...data,
      });
    } catch (err) {
      // Notification-only events: the ledger has already been updated synchronously
      logger.error({ err, eventType, key }, 'Failed to publish account event to Kafka');
    }
  }
}
