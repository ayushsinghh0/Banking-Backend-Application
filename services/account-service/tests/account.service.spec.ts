import { AccountService } from '../src/services/account.service';
import { AccountNumberGenerator } from '../src/utils/account-number.generator';
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BadGatewayError,
  HttpError,
  AuthenticatedUser,
} from '@banksphere/common';
import { AccountType, AccountStatus } from '../generated/client';

const alice: AuthenticatedUser = { id: 'alice-cust-id', email: 'alice@bank.com', role: 'CUSTOMER' };
const bob: AuthenticatedUser = { id: 'bob-intruder-id', email: 'bob@bank.com', role: 'CUSTOMER' };
const admin: AuthenticatedUser = { id: 'admin-user-id', email: 'admin@bank.com', role: 'BANK_ADMIN', mfa: true };
const support: AuthenticatedUser = { id: 'support-user-id', email: 'support@bank.com', role: 'SUPPORT', mfa: true };

describe('AccountService (Account Lifecycle, Numbers, and Ownership)', () => {
  let mockPrisma: any;
  let mockCustomer: any;
  let mockLedger: any;
  let accountService: AccountService;
  let calls: string[];

  const account = (overrides: Partial<any> = {}) => ({
    id: 'acc-1',
    customerId: 'alice-cust-id',
    status: AccountStatus.ACTIVE,
    dailyLimit: 10000000n,
    version: 3,
    ...overrides,
  });

  beforeEach(() => {
    calls = [];
    mockPrisma = {
      bankAccount: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(({ data }: any) => ({ version: 1, ...data, createdAt: new Date(), updatedAt: new Date() })),
        update: jest.fn(({ data }: any) => {
          calls.push('db');
          return account(data);
        }),
        updateMany: jest.fn(() => {
          calls.push('db');
          return { count: 1 };
        }),
      },
      outboxEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));

    mockCustomer = { getKycStatus: jest.fn().mockResolvedValue('VERIFIED') };
    mockLedger = {
      provisionAccount: jest.fn().mockResolvedValue(undefined),
      updateAccount: jest.fn(async () => {
        calls.push('ledger');
        return { applied: true };
      }),
      closeAccount: jest.fn(async () => {
        calls.push('ledger-close');
      }),
      getAccount: jest.fn(),
      getAccounts: jest.fn().mockResolvedValue([]),
    };

    accountService = new AccountService(mockPrisma, mockLedger, mockCustomer);
  });

  describe('AccountNumberGenerator', () => {
    it('generates valid 12-digit Luhn account numbers and rejects tampered ones', () => {
      for (let i = 0; i < 50; i++) {
        expect(AccountNumberGenerator.validate(AccountNumberGenerator.generate())).toBe(true);
      }
      const valid = AccountNumberGenerator.generate();
      const corrupted = valid.slice(0, 11) + ((Number(valid.slice(-1)) + 1) % 10).toString();
      expect(AccountNumberGenerator.validate(corrupted)).toBe(false);
    });
  });

  describe('createAccount', () => {
    it('provisions the ledger INACTIVE inside the transaction, activates it after commit, stages the event', async () => {
      const created = await accountService.createAccount({ customerId: 'alice-cust-id', accountType: AccountType.SAVINGS }, alice);

      expect(mockLedger.provisionAccount).toHaveBeenCalledWith(expect.objectContaining({ id: created.id, isActive: false }));
      expect(mockLedger.updateAccount).toHaveBeenCalledWith(created.id, { isActive: true, dailyLimitPaise: '10000000', version: 1 });
      expect(mockPrisma.outboxEvent.create.mock.calls[0][0].data.eventType).toBe('account.created.v1');
      // Per-customer advisory lock serialises the account-count check
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('KYC: refuses to open an account until KYC is VERIFIED', async () => {
      mockCustomer.getKycStatus.mockResolvedValue('PENDING');
      await expect(accountService.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow('identity verification');
      expect(mockLedger.provisionAccount).not.toHaveBeenCalled();
    });

    it('fails when the ledger cannot provision the account', async () => {
      mockLedger.provisionAccount.mockRejectedValue(new BadGatewayError('Ledger service is unreachable'));
      await expect(accountService.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow(BadGatewayError);
    });

    it('LIMIT ABUSE: no one can open an account with a limit above the customer cap', async () => {
      await expect(accountService.createAccount({ customerId: 'alice-cust-id', dailyLimitPaise: 999999999999n }, alice)).rejects.toThrow(ForbiddenError);
    });

    it('enforces the open-account cap inside the transaction', async () => {
      mockPrisma.bankAccount.count.mockResolvedValue(5);
      await expect(accountService.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow(ConflictError);
    });
  });

  describe('getAccountById (Ownership Enforcement)', () => {
    it('owner and staff can read; another customer gets NotFound', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      expect((await accountService.getAccountById('acc-1', alice)).id).toBe('acc-1');
      expect((await accountService.getAccountById('acc-1', admin)).id).toBe('acc-1');
      expect((await accountService.getAccountById('acc-1', support)).id).toBe('acc-1');
      await expect(accountService.getAccountById('acc-1', bob)).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateAccountStatus', () => {
    it('freeze goes to the LEDGER FIRST (fail-safe ordering) and is audited', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, alice);
      expect(calls).toEqual(['ledger', 'db']);
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it('unfreeze commits locally FIRST, then enables the ledger', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      await accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin);
      expect(calls).toEqual(['db', 'ledger']);
    });

    it('SELF-UNFREEZE: a customer cannot unfreeze an account frozen by the bank', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, alice)).rejects.toThrow(ForbiddenError);
      expect(calls).toEqual([]);
    });

    it("STAFF SELF-DEALING: an admin has only customer rights on their own account", async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ customerId: 'admin-user-id', status: AccountStatus.FROZEN }));
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)).rejects.toThrow(ForbiddenError);
    });

    it('close is decided by the ledger (zero balance under lock) before the account is marked CLOSED', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockLedger.closeAccount.mockRejectedValue(new HttpError(409, 'BALANCE_NOT_ZERO', 'Account balance must be zero'));
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.CLOSED, admin)).rejects.toThrow('balance must be zero');
      expect(mockPrisma.bankAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('updateDailyLimit', () => {
    it('lowering hits the ledger first; customers are capped; admins on their own account are capped too', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      await accountService.updateDailyLimit('acc-1', 50000n, alice);
      expect(calls).toEqual(['ledger', 'db']);

      await expect(accountService.updateDailyLimit('acc-1', 999999999999n, alice)).rejects.toThrow(ForbiddenError);
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ customerId: 'admin-user-id' }));
      await expect(accountService.updateDailyLimit('acc-1', 999999999999n, admin)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('reconcileWithLedger', () => {
    it('pushes the account state to the ledger when they diverge', async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValueOnce([account({ status: AccountStatus.FROZEN })]).mockResolvedValue([]);
      mockLedger.getAccounts.mockResolvedValue([
        { id: 'acc-1', isActive: true, closed: false, dailyLimitPaise: '10000000', balanceInPaise: '0', controlVersion: 2 },
      ]);
      const result = await accountService.reconcileWithLedger();
      expect(result.repaired).toBe(1);
      // The push carries the account's version, so the ledger can reject it if it already has something newer
      expect(mockLedger.updateAccount).toHaveBeenCalledWith('acc-1', { isActive: false, dailyLimitPaise: '10000000', version: 3 });
    });

    it('never pushes over a newer ledger state: it raises an alert instead', async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValueOnce([account({ status: AccountStatus.ACTIVE })]).mockResolvedValue([]);
      mockLedger.getAccounts.mockResolvedValue([
        { id: 'acc-1', isActive: false, closed: false, dailyLimitPaise: '10000000', balanceInPaise: '0', controlVersion: 4 },
      ]);
      const result = await accountService.reconcileWithLedger();
      expect(result.repaired).toBe(0);
      expect(mockLedger.updateAccount).not.toHaveBeenCalled();
    });

    it('counts a push the ledger ignored as not repaired', async () => {
      mockLedger.updateAccount.mockResolvedValue({ applied: false });
      mockPrisma.bankAccount.findMany.mockResolvedValueOnce([account({ status: AccountStatus.FROZEN })]).mockResolvedValue([]);
      mockLedger.getAccounts.mockResolvedValue([
        { id: 'acc-1', isActive: true, closed: false, dailyLimitPaise: '10000000', balanceInPaise: '0', controlVersion: 3 },
      ]);
      expect((await accountService.reconcileWithLedger()).repaired).toBe(0);
    });
  });
});
