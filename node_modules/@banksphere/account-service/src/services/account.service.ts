import crypto from 'crypto';
import { PrismaClient, BankAccount, AccountType, AccountStatus } from '../generated/client';
import { NotFoundError, ForbiddenError, ConflictError } from '@banksphere/common';
import { AccountNumberGenerator } from '../utils/account-number.generator';

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
    private readonly kafkaPublisher?: KafkaPublisher
  ) {}

  /**
   * Provisions a new bank account and publishes 'account.created.v1' to Kafka
   */
  public async createAccount(dto: CreateAccountDTO): Promise<BankAccount> {
    // Generate a unique 12-digit account number with collision retry safeguard
    let accountNumber = '';
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 5) {
      accountNumber = AccountNumberGenerator.generate();
      const existing = await this.prisma.bankAccount.findUnique({
        where: { accountNumber },
      });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new ConflictError('Failed to allocate unique account number. Please retry.');
    }

    const account = await this.prisma.bankAccount.create({
      data: {
        accountNumber,
        customerId: dto.customerId,
        accountType: dto.accountType || AccountType.SAVINGS,
        currency: dto.currency || 'INR',
        dailyLimit: dto.dailyLimitPaise || 10000000n, // ₹1,00,000.00 default daily limit
        status: AccountStatus.ACTIVE,
      },
    });

    // Publish account.created.v1 event to Kafka for downstream services (Ledger, Notification)
    if (this.kafkaPublisher) {
      const eventPayload = {
        eventId: crypto.randomUUID(),
        eventType: 'account.created.v1',
        timestamp: new Date().toISOString(),
        accountId: account.id,
        accountNumber: account.accountNumber,
        customerId: account.customerId,
        accountType: account.accountType,
        currency: account.currency,
        status: account.status,
      };

      try {
        await this.kafkaPublisher.publish('account.created.v1', account.id, eventPayload);
      } catch (err) {
        console.error('[AccountService] Failed to publish account.created.v1 event to Kafka', err);
      }
    }

    return account;
  }

  /**
   * Retrieves account details with strict ownership verification
   */
  public async getAccountById(
    accountId: string,
    requestingCustomerId: string,
    isAdmin = false
  ): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundError(`Bank account '${accountId}' not found`);
    }

    // OWNERSHIP CHECK: Prevent User A from viewing User B's account
    if (!isAdmin && account.customerId !== requestingCustomerId) {
      throw new ForbiddenError('You do not have permission to view or manage this account');
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
   * Updates an account's operational lifecycle status (e.g. ACTIVE -> FROZEN -> CLOSED)
   */
  public async updateAccountStatus(
    accountId: string,
    status: AccountStatus,
    requestingCustomerId: string,
    isAdmin = false
  ): Promise<BankAccount> {
    const account = await this.getAccountById(accountId, requestingCustomerId, isAdmin);

    if (account.status === AccountStatus.CLOSED) {
      throw new ConflictError('Cannot alter status of an already permanently closed account');
    }

    return this.prisma.bankAccount.update({
      where: { id: accountId },
      data: { status },
    });
  }
}
