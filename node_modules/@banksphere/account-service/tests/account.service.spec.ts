import { AccountService } from '../src/services/account.service';
import { AccountNumberGenerator } from '../src/utils/account-number.generator';
import { ForbiddenError, NotFoundError, ConflictError } from '@banksphere/common';
import { AccountType, AccountStatus } from '../src/generated/client';

describe('AccountService (Account Lifecycle, Numbers, and Ownership)', () => {
  let mockPrisma: any;
  let mockKafka: any;
  let accountService: AccountService;

  beforeEach(() => {
    mockPrisma = {
      bankAccount: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    mockKafka = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    accountService = new AccountService(mockPrisma, mockKafka);
  });

  describe('AccountNumberGenerator', () => {
    it('should generate valid 12-digit account numbers that pass Luhn checksum', () => {
      for (let i = 0; i < 20; i++) {
        const accNum = AccountNumberGenerator.generate();
        expect(accNum).toHaveLength(12);
        expect(AccountNumberGenerator.validate(accNum)).toBe(true);
      }
    });

    it('should reject tampered or corrupted account numbers', () => {
      const validNum = AccountNumberGenerator.generate();
      // Corrupt the last check digit
      const lastDigit = parseInt(validNum.slice(-1), 10);
      const corruptedLastDigit = (lastDigit + 1) % 10;
      const corruptedNum = validNum.slice(0, 11) + corruptedLastDigit.toString();

      expect(AccountNumberGenerator.validate(corruptedNum)).toBe(false);
    });
  });

  describe('createAccount', () => {
    it('should provision a new bank account and publish account.created.v1 event to Kafka', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(null); // No collision
      mockPrisma.bankAccount.create.mockImplementation(({ data }: any) => ({
        id: 'acc-uuid-1',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const account = await accountService.createAccount({
        customerId: 'cust-123',
        accountType: AccountType.SAVINGS,
      });

      expect(account.id).toBe('acc-uuid-1');
      expect(account.customerId).toBe('cust-123');
      expect(account.accountNumber).toHaveLength(12);

      // Verify Kafka event published
      expect(mockKafka.publish).toHaveBeenCalledWith(
        'account.created.v1',
        'acc-uuid-1',
        expect.objectContaining({
          eventType: 'account.created.v1',
          accountId: 'acc-uuid-1',
          customerId: 'cust-123',
        })
      );
    });
  });

  describe('getAccountById (Ownership Enforcement)', () => {
    it('should allow account owner to retrieve their account details', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue({
        id: 'acc-1',
        customerId: 'alice-cust-id',
        status: AccountStatus.ACTIVE,
      });

      const result = await accountService.getAccountById('acc-1', 'alice-cust-id', false);
      expect(result.id).toBe('acc-1');
    });

    it('should throw ForbiddenError if another customer attempts to access the account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue({
        id: 'acc-1',
        customerId: 'alice-cust-id',
        status: AccountStatus.ACTIVE,
      });

      await expect(
        accountService.getAccountById('acc-1', 'bob-intruder-id', false)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should allow bank administrators to view any customer account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue({
        id: 'acc-1',
        customerId: 'alice-cust-id',
        status: AccountStatus.ACTIVE,
      });

      const result = await accountService.getAccountById('acc-1', 'admin-user-id', true);
      expect(result.id).toBe('acc-1');
    });
  });

  describe('updateAccountStatus', () => {
    it('should prevent altering status of an already permanently CLOSED account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue({
        id: 'acc-1',
        customerId: 'alice-cust-id',
        status: AccountStatus.CLOSED,
      });

      await expect(
        accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, 'alice-cust-id', false)
      ).rejects.toThrow(ConflictError);
    });
  });
});
