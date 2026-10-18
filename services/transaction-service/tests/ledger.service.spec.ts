import { LedgerService, startOfIstDay } from '../src/services/ledger.service';
import { IdempotencyService } from '../src/services/idempotency.service';
import {
  InsufficientFundsError,
  SameAccountTransferError,
  InvalidAmountError,
  NotFoundError,
  DailyLimitExceededError,
  AccountInactiveError,
  CurrencyMismatchError,
  IdempotencyKeyReuseError,
} from '../src/errors';
import { AuthenticatedUser } from '@banksphere/common';

const alice: AuthenticatedUser = { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER' };
const mallory: AuthenticatedUser = { id: 'mallory', email: 'mallory@bank.com', role: 'CUSTOMER' };
const teller: AuthenticatedUser = { id: 'teller', email: 'teller@bank.com', role: 'BANK_ADMIN' };

const row = (id: string, balance: bigint, customer: string, extra: Partial<any> = {}) => ({
  id,
  balance,
  is_active: true,
  account_number: `10010000000${id.slice(-1)}`,
  customer_id: customer,
  currency: 'INR',
  daily_limit: 10000000n,
  ...extra,
});

describe('LedgerService (Financial Invariants and Concurrency)', () => {
  let mockPrisma: any;
  let ledgerService: LedgerService;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((callback) => callback(mockPrisma)),
      $queryRaw: jest.fn(),
      transaction: { create: jest.fn() },
      ledgerEntry: {
        create: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
        findMany: jest.fn(),
      },
      ledgerAccount: { update: jest.fn(), findUnique: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };
    ledgerService = new LedgerService(mockPrisma);
  });

  describe('executeTransfer', () => {
    it('should reject transfers with negative or zero amounts', async () => {
      for (const amountInPaise of [0n, -500n]) {
        await expect(
          ledgerService.executeTransfer(
            { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise },
            alice
          )
        ).rejects.toThrow(InvalidAmountError);
      }
    });

    it('should reject transfers where source and destination are the same account', async () => {
      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-1', amountInPaise: 1000n },
          alice
        )
      ).rejects.toThrow(SameAccountTransferError);
    });

    it('THEFT: a customer cannot move money out of an account they do not own', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([row('acc-1', 50000n, 'alice'), row('acc-2', 0n, 'mallory')]);

      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 50000n },
          mallory
        )
      ).rejects.toThrow(NotFoundError);
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('should abort and throw InsufficientFundsError if balance is less than transfer amount', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([row('acc-1', 5000n, 'alice'), row('acc-2', 10000n, 'bob')]);

      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 6000n },
          alice
        )
      ).rejects.toThrow(InsufficientFundsError);

      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
      expect(mockPrisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('rejects transfers involving a frozen account', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        row('acc-1', 50000n, 'alice'),
        row('acc-2', 0n, 'bob', { is_active: false }),
      ]);
      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 100n },
          alice
        )
      ).rejects.toThrow(AccountInactiveError);
    });

    it('rejects transfers across currencies', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        row('acc-1', 50000n, 'alice'),
        row('acc-2', 0n, 'bob', { currency: 'USD' }),
      ]);
      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 100n },
          alice
        )
      ).rejects.toThrow(CurrencyMismatchError);
    });

    it('DAILY LIMIT: rejects a debit that would push today\'s outgoing total over the limit', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        row('acc-1', 50000000n, 'alice', { daily_limit: 1000000n }),
        row('acc-2', 0n, 'bob'),
      ]);
      mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 900000n } });

      await expect(
        ledgerService.executeTransfer(
          { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 200000n },
          alice
        )
      ).rejects.toThrow(DailyLimitExceededError);
      expect(mockPrisma.ledgerEntry.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ accountId: 'acc-1', entryType: 'DEBIT' }),
        })
      );
    });

    it('should create balanced double-entry ledger records and an outbox event on success', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([row('acc-1', 10000n, 'alice'), row('acc-2', 2000n, 'bob')]);

      mockPrisma.transaction.create.mockImplementation(({ data }: any) => ({
        id: 'tx-123',
        createdAt: new Date(),
        ...data,
      }));

      const result = await ledgerService.executeTransfer(
        { sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 3000n },
        alice
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.amountInPaise).toBe('3000');
      expect(mockPrisma.transaction.create.mock.calls[0][0].data.initiatedBy).toBe('alice');

      expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          accountId: 'acc-1',
          entryType: 'DEBIT',
          amount: 3000n,
          balanceAfter: 7000n,
        }),
      });
      expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          accountId: 'acc-2',
          entryType: 'CREDIT',
          amount: 3000n,
          balanceAfter: 5000n,
        }),
      });

      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          aggregateType: 'TRANSACTION',
          aggregateId: 'tx-123',
          eventType: 'transaction.completed.v1',
          status: 'PENDING',
          payload: expect.objectContaining({ sourceCustomerId: 'alice', destinationCustomerId: 'bob' }),
        }),
      });
    });
  });

  describe('executeWithdrawal / executeDeposit', () => {
    it('THEFT: a customer cannot withdraw from someone else\'s account', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([row('acc-1', 50000n, 'alice')]);
      await expect(
        ledgerService.executeWithdrawal({ accountId: 'acc-1', amountInPaise: 100n }, mallory)
      ).rejects.toThrow(NotFoundError);
    });

    it('a teller deposit credits the account', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([row('acc-1', 100n, 'alice')]);
      mockPrisma.transaction.create.mockImplementation(({ data }: any) => ({
        id: 'tx-dep',
        createdAt: new Date(),
        ...data,
      }));
      const result = await ledgerService.executeDeposit({ accountId: 'acc-1', amountInPaise: 900n }, teller);
      expect(result.type).toBe('DEPOSIT');
      expect(mockPrisma.ledgerAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { balance: 1000n },
      });
    });
  });

  describe('read access', () => {
    it('IDOR: another customer cannot read the balance', async () => {
      mockPrisma.ledgerAccount.findUnique.mockResolvedValue({ id: 'acc-1', customerId: 'alice', balance: 5n, currency: 'INR' });
      await expect(ledgerService.getAccountBalance('acc-1', mallory)).rejects.toThrow(NotFoundError);
      await expect(ledgerService.getAccountBalance('acc-1', alice)).resolves.toEqual(
        expect.objectContaining({ balanceInPaise: '5' })
      );
    });
  });

  describe('startOfIstDay', () => {
    it('returns the UTC instant of the most recent IST midnight', () => {
      // 2026-01-01T20:00Z is 2026-01-02 01:30 IST -> IST midnight is 2026-01-01T18:30Z
      expect(startOfIstDay(new Date('2026-01-01T20:00:00Z')).toISOString()).toBe('2026-01-01T18:30:00.000Z');
      // 2026-01-01T10:00Z is 15:30 IST -> 2025-12-31T18:30Z
      expect(startOfIstDay(new Date('2026-01-01T10:00:00Z')).toISOString()).toBe('2025-12-31T18:30:00.000Z');
    });
  });
});

describe('IdempotencyService', () => {
  const ctx = { userId: 'alice', key: 'key-12345678', endpoint: 'transfer', requestHash: 'h1' };

  it('produces the same hash regardless of key order', () => {
    const service = new IdempotencyService({} as any);
    expect(service.generateRequestHash({ a: 1, b: 2 })).toBe(service.generateRequestHash({ b: 2, a: 1 }));
  });

  it('replays the stored response for a completed key', async () => {
    const prisma: any = {
      idempotencyRecord: {
        findUnique: jest.fn().mockResolvedValue({
          ...ctx,
          status: 'COMPLETED',
          statusCode: 201,
          responseBody: { success: true },
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
      $transaction: jest.fn(),
    };
    const result = await new IdempotencyService(prisma).execute(ctx, jest.fn());
    expect(result).toEqual({ statusCode: 201, responseBody: { success: true }, replayed: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reuse of a key with a different payload', async () => {
    const prisma: any = {
      idempotencyRecord: {
        findUnique: jest.fn().mockResolvedValue({
          ...ctx,
          requestHash: 'different',
          status: 'COMPLETED',
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
    };
    await expect(new IdempotencyService(prisma).execute(ctx, jest.fn())).rejects.toThrow(
      IdempotencyKeyReuseError
    );
  });

  it('CONCURRENCY: losing the unique-key race replays the winner instead of moving money twice', async () => {
    const winner = {
      ...ctx,
      status: 'COMPLETED',
      statusCode: 201,
      responseBody: { success: true, data: { transactionId: 'tx-1' } },
      expiresAt: new Date(Date.now() + 60000),
    };
    const prisma: any = {
      idempotencyRecord: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      },
      $transaction: jest.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' })),
    };
    const work = jest.fn();
    const result = await new IdempotencyService(prisma).execute(ctx, work);
    expect(result.replayed).toBe(true);
    expect(result.responseBody.data.transactionId).toBe('tx-1');
  });
});
