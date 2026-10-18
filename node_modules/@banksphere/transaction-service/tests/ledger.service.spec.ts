import { LedgerService } from '../src/services/ledger.service';
import { InsufficientFundsError, SameAccountTransferError, InvalidAmountError } from '../src/errors';

describe('LedgerService (Financial Invariants and Concurrency)', () => {
  let mockPrisma: any;
  let ledgerService: LedgerService;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((callback) => callback(mockPrisma)),
      $queryRaw: jest.fn(),
      transaction: {
        create: jest.fn(),
      },
      ledgerEntry: {
        create: jest.fn(),
      },
      ledgerAccount: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      outboxEvent: {
        create: jest.fn(),
      },
    };
    ledgerService = new LedgerService(mockPrisma);
  });

  describe('executeTransfer', () => {
    it('should reject transfers with negative or zero amounts', async () => {
      await expect(
        ledgerService.executeTransfer({
          sourceAccountId: 'acc-1',
          destinationAccountId: 'acc-2',
          amountInPaise: 0n,
        })
      ).rejects.toThrow(InvalidAmountError);

      await expect(
        ledgerService.executeTransfer({
          sourceAccountId: 'acc-1',
          destinationAccountId: 'acc-2',
          amountInPaise: -500n,
        })
      ).rejects.toThrow(InvalidAmountError);
    });

    it('should reject transfers where source and destination are the same account', async () => {
      await expect(
        ledgerService.executeTransfer({
          sourceAccountId: 'acc-1',
          destinationAccountId: 'acc-1',
          amountInPaise: 1000n,
        })
      ).rejects.toThrow(SameAccountTransferError);
    });

    it('should abort and throw InsufficientFundsError if balance is less than transfer amount', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'acc-1', balance: 5000n, is_active: true, account_number: '1001' },
        { id: 'acc-2', balance: 10000n, is_active: true, account_number: '1002' },
      ]);

      await expect(
        ledgerService.executeTransfer({
          sourceAccountId: 'acc-1',
          destinationAccountId: 'acc-2',
          amountInPaise: 6000n, // Exceeds 5000n balance
        })
      ).rejects.toThrow(InsufficientFundsError);

      // Verify no records were created
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
      expect(mockPrisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('should create balanced double-entry ledger records and an outbox event on success', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'acc-1', balance: 10000n, is_active: true, account_number: '1001' },
        { id: 'acc-2', balance: 2000n, is_active: true, account_number: '1002' },
      ]);

      mockPrisma.transaction.create.mockResolvedValue({
        id: 'tx-123',
        referenceId: 'TXN-TRF-001',
        type: 'TRANSFER',
        status: 'COMPLETED',
        amount: 3000n,
        sourceAccountId: 'acc-1',
        destinationAccountId: 'acc-2',
        createdAt: new Date(),
      });

      const result = await ledgerService.executeTransfer({
        sourceAccountId: 'acc-1',
        destinationAccountId: 'acc-2',
        amountInPaise: 3000n,
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.amountInPaise).toBe('3000');

      // Verify two ledger entries were created (DEBIT and CREDIT)
      expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(2);

      // 1st entry: DEBIT source account
      expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          accountId: 'acc-1',
          entryType: 'DEBIT',
          amount: 3000n,
          balanceAfter: 7000n,
        }),
      });

      // 2nd entry: CREDIT destination account
      expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          accountId: 'acc-2',
          entryType: 'CREDIT',
          amount: 3000n,
          balanceAfter: 5000n,
        }),
      });

      // Verify transactional outbox event created
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          aggregateType: 'TRANSACTION',
          aggregateId: 'tx-123',
          eventType: 'transaction.completed.v1',
          status: 'PENDING',
        }),
      });
    });
  });
});
