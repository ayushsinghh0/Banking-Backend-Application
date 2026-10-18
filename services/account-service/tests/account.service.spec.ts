import { AccountService } from '../src/services/account.service';
import { AccountNumberGenerator } from '../src/utils/account-number.generator';
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BadGatewayError,
  AuthenticatedUser,
} from '@banksphere/common';
import { AccountType, AccountStatus } from '../generated/client';

const alice: AuthenticatedUser = { id: 'alice-cust-id', email: 'alice@bank.com', role: 'CUSTOMER' };
const bob: AuthenticatedUser = { id: 'bob-intruder-id', email: 'bob@bank.com', role: 'CUSTOMER' };
const admin: AuthenticatedUser = { id: 'admin-user-id', email: 'admin@bank.com', role: 'BANK_ADMIN' };
const support: AuthenticatedUser = { id: 'support-user-id', email: 'support@bank.com', role: 'SUPPORT' };

describe('AccountService (Account Lifecycle, Numbers, and Ownership)', () => {
  let mockPrisma: any;
  let mockCustomer: any;
  let mockLedger: any;
  let accountService: AccountService;

  const aliceAccount = (status: AccountStatus = AccountStatus.ACTIVE) => ({
    id: 'acc-1',
    customerId: 'alice-cust-id',
    status,
    dailyLimit: 10000000n,
  });

  beforeEach(() => {
    mockPrisma = {
      bankAccount: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      outboxEvent: { create: jest.fn() },
      $transaction: jest.fn((cb: any) => cb(mockPrisma)),
    };

    mockCustomer = { getKycStatus: jest.fn().mockResolvedValue('VERIFIED') };
    mockLedger = {
      provisionAccount: jest.fn().mockResolvedValue(undefined),
      updateAccount: jest.fn().mockResolvedValue(undefined),
      getAccount: jest.fn().mockResolvedValue({ id: 'acc-1', balanceInPaise: '0', isActive: true }),
    };

    accountService = new AccountService(mockPrisma, mockLedger, mockCustomer);
  });

  describe('AccountNumberGenerator', () => {
    it('should generate valid 12-digit account numbers that pass Luhn checksum', () => {
      for (let i = 0; i < 50; i++) {
        const accNum = AccountNumberGenerator.generate();
        expect(accNum).toHaveLength(12);
        expect(AccountNumberGenerator.validate(accNum)).toBe(true);
      }
    });

    it('should reject tampered or corrupted account numbers', () => {
      const validNum = AccountNumberGenerator.generate();
      const lastDigit = parseInt(validNum.slice(-1), 10);
      const corruptedNum = validNum.slice(0, 11) + ((lastDigit + 1) % 10).toString();

      expect(AccountNumberGenerator.validate(corruptedNum)).toBe(false);
    });
  });

  describe('createAccount', () => {
    beforeEach(() => {
      mockPrisma.bankAccount.create.mockImplementation(({ data }: any) => ({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    });

    it('provisions the ledger account and stages account.created.v1 in the outbox', async () => {
      const account = await accountService.createAccount(
        { customerId: 'alice-cust-id', accountType: AccountType.SAVINGS },
        alice
      );

      expect(account.customerId).toBe('alice-cust-id');
      expect(account.accountNumber).toHaveLength(12);
      expect(mockLedger.provisionAccount).toHaveBeenCalledWith(
        expect.objectContaining({ id: account.id, customerId: 'alice-cust-id', isActive: true })
      );
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'account.created.v1',
          aggregateId: account.id,
          payload: expect.objectContaining({ eventType: 'account.created.v1', customerId: 'alice-cust-id' }),
        }),
      });
    });

    it('KYC: refuses to open an account until KYC is VERIFIED', async () => {
      mockCustomer.getKycStatus.mockResolvedValue('PENDING');
      await expect(accountService.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow(
        'identity verification'
      );
      expect(mockPrisma.bankAccount.create).not.toHaveBeenCalled();
      expect(mockLedger.provisionAccount).not.toHaveBeenCalled();
    });

    it('fails (and rolls back) when the ledger cannot provision the account', async () => {
      mockLedger.provisionAccount.mockRejectedValue(new BadGatewayError('Ledger service is unreachable'));

      await expect(
        accountService.createAccount({ customerId: 'alice-cust-id' }, alice)
      ).rejects.toThrow(BadGatewayError);
    });

    it('LIMIT ABUSE: customers cannot grant themselves a daily limit above the cap', async () => {
      await expect(
        accountService.createAccount(
          { customerId: 'alice-cust-id', dailyLimitPaise: 999999999999n },
          alice
        )
      ).rejects.toThrow(ForbiddenError);
      expect(mockPrisma.bankAccount.create).not.toHaveBeenCalled();
    });

    it('rejects non-INR currencies (the ledger has no FX)', async () => {
      await expect(
        accountService.createAccount({ customerId: 'alice-cust-id', currency: 'USD' }, alice)
      ).rejects.toThrow('Only INR accounts are supported');
    });
  });

  describe('getAccountById (Ownership Enforcement)', () => {
    it('should allow account owner to retrieve their account details', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount());
      const result = await accountService.getAccountById('acc-1', alice);
      expect(result.id).toBe('acc-1');
    });

    it('IDOR: another customer gets NotFound (indistinguishable from a missing account)', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount());
      await expect(accountService.getAccountById('acc-1', bob)).rejects.toThrow(NotFoundError);
    });

    it('should allow bank staff to view any customer account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount());
      expect((await accountService.getAccountById('acc-1', admin)).id).toBe('acc-1');
      expect((await accountService.getAccountById('acc-1', support)).id).toBe('acc-1');
    });
  });

  describe('updateAccountStatus', () => {
    it('should prevent altering status of an already permanently CLOSED account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount(AccountStatus.CLOSED));
      await expect(
        accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)
      ).rejects.toThrow(ConflictError);
    });

    it('lets a customer freeze their own account and propagates it to the ledger', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount());
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(aliceAccount(AccountStatus.FROZEN));

      const updated = await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, alice);

      expect(updated.status).toBe(AccountStatus.FROZEN);
      expect(mockLedger.updateAccount).toHaveBeenCalledWith('acc-1', { isActive: false });
    });

    it('SELF-UNFREEZE: a customer cannot unfreeze an account frozen by the bank', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount(AccountStatus.FROZEN));
      await expect(
        accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, alice)
      ).rejects.toThrow(ForbiddenError);
      expect(mockLedger.updateAccount).not.toHaveBeenCalled();
    });

    it('refuses to close an account that still holds money', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(aliceAccount());
      mockLedger.getAccount.mockResolvedValue({ id: 'acc-1', balanceInPaise: '500', isActive: true });
      await expect(
        accountService.updateAccountStatus('acc-1', AccountStatus.CLOSED, admin)
      ).rejects.toThrow('Account balance must be zero');
    });
  });
});
