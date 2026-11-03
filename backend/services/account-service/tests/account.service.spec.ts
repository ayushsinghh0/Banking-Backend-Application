import { AccountService } from '../src/services/account.service';
import { AccountNumberGenerator } from '../src/utils/account-number.generator';
import {
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BadGatewayError,
  HttpError,
  AuthenticatedUser,
  logger,
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
    bankLimitCeiling: null,
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
        updateMany: jest.fn(({ data }: any) => {
          calls.push(data?.version?.increment ? 'reserve-version' : 'db');
          return { count: 1 };
        }),
      },
      staffAccessLog: { create: jest.fn() },
      outboxEvent: { create: jest.fn() },
      auditLog: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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

    it('NUMBER SPACE: 10 random digits after a 1-digit prefix (not a fixed 4-digit prefix + 7 digits)', () => {
      const numbers = Array.from({ length: 300 }, () => AccountNumberGenerator.generate());
      for (const n of numbers) expect(n).toMatch(/^2\d{11}$/);
      // Digits 2-4 were the fixed "001" of the old branch prefix; they must now be random too
      expect(new Set(numbers.map((n) => n.slice(1, 4))).size).toBeGreaterThan(100);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('numbers issued in the old format stay valid', () => {
      // 1001 + 7 digits + Luhn, as issued before the format change
      const legacyPayload = '10012345678';
      const legacy = [...Array(10).keys()].map((d) => legacyPayload + d).filter((n) => AccountNumberGenerator.validate(n));
      expect(legacy).toHaveLength(1);
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
      // A business refusal is not a number collision: no retry
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('NUMBER COLLISION: a local unique violation is retried with a fresh number', async () => {
      mockPrisma.bankAccount.create.mockImplementationOnce(() => {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`account_number`)'), { code: 'P2002' });
      });
      const created = await accountService.createAccount({ customerId: 'alice-cust-id' }, alice);
      expect(mockPrisma.bankAccount.create).toHaveBeenCalledTimes(2);
      expect(created.accountNumber).toBe(mockPrisma.bankAccount.create.mock.calls[1][0].data.accountNumber);
    });

    it('NUMBER COLLISION: a number the ledger already holds (orphaned ledger account, 409) is retried too', async () => {
      mockLedger.provisionAccount.mockRejectedValueOnce(new HttpError(409, 'CONFLICT', 'Resource already exists'));
      const created = await accountService.createAccount({ customerId: 'alice-cust-id' }, alice);
      expect(mockLedger.provisionAccount).toHaveBeenCalledTimes(2);
      const [first, second] = mockLedger.provisionAccount.mock.calls.map(([input]: any) => input);
      expect(second.accountNumber).not.toBe(first.accountNumber);
      expect(second.id).not.toBe(first.id);
      expect(created.accountNumber).toBe(second.accountNumber);
    });

    it('gives up with a 409 when every attempt collides', async () => {
      mockLedger.provisionAccount.mockRejectedValue(new HttpError(409, 'CONFLICT', 'Resource already exists'));
      await expect(accountService.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow('unique account number');
      expect(mockLedger.updateAccount).not.toHaveBeenCalled();
    });

    it('AFTER COMMIT: a failed ledger activation still returns the created account (no 502 inviting a duplicate)', async () => {
      mockLedger.updateAccount.mockRejectedValue(new BadGatewayError('Ledger service is unreachable'));
      const alert = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      const created = await accountService.createAccount({ customerId: 'alice-cust-id' }, alice);
      expect(created.id).toBeDefined();
      expect(created.status).toBe(AccountStatus.ACTIVE);
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledTimes(1);
      // Left for reconcileWithLedger(), and raised so someone notices
      expect(alert).toHaveBeenCalledWith(expect.objectContaining({ accountId: created.id, alert: 'ACCOUNT_LEDGER_ACTIVATION_FAILED' }), expect.any(String));
      alert.mockRestore();
    });

    it('AFTER COMMIT: an activation the ledger did not apply is not treated as success, but the account is returned', async () => {
      mockLedger.updateAccount.mockResolvedValue({ applied: false });
      const alert = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      const created = await accountService.createAccount({ customerId: 'alice-cust-id' }, alice);
      expect(created.id).toBeDefined();
      expect(alert).toHaveBeenCalledWith(expect.objectContaining({ accountId: created.id, alert: 'ACCOUNT_LEDGER_ACTIVATION_NOT_APPLIED' }), expect.any(String));
      alert.mockRestore();
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
    const freezeBy = (actorId: string) => ({ actorId, action: 'ACCOUNT_STATUS_CHANGED', details: { from: 'ACTIVE', to: 'FROZEN' } });
    const holdBy = (actorId: string) => ({ actorId, action: 'ACCOUNT_BANK_HOLD', details: { status: 'FROZEN' } });

    it('freeze goes to the LEDGER FIRST (fail-safe ordering) and is audited', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, alice);
      expect(calls).toEqual(['reserve-version', 'ledger', 'db']);
      // The ledger gets the freshly reserved version, never one another writer could also be using
      expect(mockLedger.updateAccount).toHaveBeenCalledWith('acc-1', expect.objectContaining({ isActive: false, version: 4 }));
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it('unfreeze commits locally FIRST, then enables the ledger', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      await accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin);
      expect(calls).toEqual(['reserve-version', 'db', 'ledger']);
    });

    it('VERSION RACE: a concurrent writer that already took the next version makes this change fail, not collide', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockPrisma.bankAccount.updateMany.mockImplementationOnce(() => ({ count: 0 }));
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, admin)).rejects.toThrow(ConflictError);
      expect(mockLedger.updateAccount).not.toHaveBeenCalled();
    });

    it('a ledger push that was not applied is a failure, never a silent success', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockLedger.updateAccount.mockResolvedValue({ applied: false });
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, admin)).rejects.toThrow(ConflictError);
      expect(calls).not.toContain('db');
    });

    it('DUAL CONTROL: an admin who froze an account cannot unfreeze it; another admin can', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      mockPrisma.auditLog.findMany.mockResolvedValue([freezeBy('admin-user-id')]);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)).rejects.toThrow(ForbiddenError);
      const admin2 = { ...admin, id: 'admin-2' };
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin2)).resolves.toBeDefined();
    });

    it('BANK HOLD: an admin freezing an account the customer already froze records the hold (ledger first, no status event)', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account({ status: AccountStatus.FROZEN, version: 4 }));
      mockPrisma.auditLog.findMany.mockResolvedValue([freezeBy('alice-cust-id')]);
      await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, admin);
      expect(calls).toEqual(['reserve-version', 'ledger', 'db']);
      expect(mockLedger.updateAccount).toHaveBeenCalledWith('acc-1', expect.objectContaining({ isActive: false, version: 4 }));
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ actorId: 'admin-user-id', action: 'ACCOUNT_BANK_HOLD', targetId: 'acc-1' }),
      });
      // The status did not change, so no "your account is now FROZEN" notice is sent again
      expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    });

    it('BANK HOLD: the admin who placed the hold cannot lift it alone; a different admin can', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      mockPrisma.auditLog.findMany.mockResolvedValue([holdBy('admin-user-id'), freezeBy('alice-cust-id')]);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)).rejects.toThrow(ForbiddenError);
      expect(calls).toEqual([]);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, { ...admin, id: 'admin-2' })).resolves.toBeDefined();
    });

    it('DUAL CONTROL: the admin who froze an account still cannot unfreeze it after a second admin confirmed the hold', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      mockPrisma.auditLog.findMany.mockResolvedValue([holdBy('admin-2'), freezeBy('admin-user-id')]);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)).rejects.toThrow(ForbiddenError);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, { ...admin, id: 'admin-2' })).rejects.toThrow(ForbiddenError);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, { ...admin, id: 'admin-3' })).resolves.toBeDefined();
    });

    it('only holds placed since the account was last frozen count', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.bankAccount.findUniqueOrThrow.mockResolvedValue(account());
      // An old hold by this admin, lifted since; the account was then frozen again by the customer
      mockPrisma.auditLog.findMany.mockResolvedValue([freezeBy('alice-cust-id'), { actorId: 'admin-2', action: 'ACCOUNT_STATUS_CHANGED', details: { from: 'FROZEN', to: 'ACTIVE' } }, holdBy('admin-user-id')]);
      await expect(accountService.updateAccountStatus('acc-1', AccountStatus.ACTIVE, admin)).resolves.toBeDefined();
    });

    it('re-freezing is a no-op for the customer and for an admin who already holds the account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ status: AccountStatus.FROZEN }));
      mockPrisma.auditLog.findMany.mockResolvedValue([freezeBy('alice-cust-id')]);
      await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, alice);
      mockPrisma.auditLog.findMany.mockResolvedValue([holdBy('admin-user-id'), freezeBy('alice-cust-id')]);
      await accountService.updateAccountStatus('acc-1', AccountStatus.FROZEN, admin);
      expect(calls).toEqual([]);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
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
      // Only the version was reserved; the account was never marked closed
      expect(calls).toEqual(['reserve-version']);
    });
  });

  describe('updateDailyLimit', () => {
    const limitWrite = () =>
      mockPrisma.bankAccount.updateMany.mock.calls.map(([args]: any) => args).find((args: any) => args.data.dailyLimit !== undefined);

    it('lowering hits the ledger first; customers are capped; admins on their own account are capped too', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      await accountService.updateDailyLimit('acc-1', 50000n, alice);
      expect(calls).toEqual(['reserve-version', 'ledger', 'db']);

      // Setting the current value again is a no-op (it used to push a "lowering" to the ledger)
      calls.length = 0;
      await accountService.updateDailyLimit('acc-1', 10000000n, alice);
      expect(calls).toEqual([]);

      await expect(accountService.updateDailyLimit('acc-1', 999999999999n, alice)).rejects.toThrow(ForbiddenError);
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ customerId: 'admin-user-id' }));
      await expect(accountService.updateDailyLimit('acc-1', 999999999999n, admin)).rejects.toThrow(ForbiddenError);
    });

    it('BANK CEILING: a limit set by an administrator becomes a ceiling the owner cannot raise past', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      await accountService.updateDailyLimit('acc-1', 20000n, admin);
      expect(limitWrite().data).toEqual({ dailyLimit: 20000n, bankLimitCeiling: 20000n });

      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 20000n, bankLimitCeiling: 20000n }));
      calls.length = 0;
      await expect(accountService.updateDailyLimit('acc-1', 10000000n, alice)).rejects.toThrow(ForbiddenError);
      await expect(accountService.updateDailyLimit('acc-1', 20001n, alice)).rejects.toThrow(ForbiddenError);
      expect(calls).toEqual([]);
    });

    it('BANK CEILING: the owner may lower freely and raise back up to the ceiling, never moving the ceiling', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 20000n, bankLimitCeiling: 20000n }));
      await accountService.updateDailyLimit('acc-1', 5000n, alice);
      expect(limitWrite().data).toEqual({ dailyLimit: 5000n });

      mockPrisma.bankAccount.updateMany.mockClear();
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 5000n, bankLimitCeiling: 20000n }));
      await accountService.updateDailyLimit('acc-1', 20000n, alice);
      expect(limitWrite().data).toEqual({ dailyLimit: 20000n });
    });

    it('BANK CEILING: above the customer cap the owner may lower, but raises stay within the cap', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 50000000n, bankLimitCeiling: 50000000n }));
      await accountService.updateDailyLimit('acc-1', 30000000n, alice);
      expect(limitWrite().data).toEqual({ dailyLimit: 30000000n });
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 30000000n, bankLimitCeiling: 50000000n }));
      await expect(accountService.updateDailyLimit('acc-1', 40000000n, alice)).rejects.toThrow(ForbiddenError);
    });

    it('BANK CEILING: an admin can raise the ceiling, or impose the current limit as one; not on their own account', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ dailyLimit: 20000n, bankLimitCeiling: 20000n }));
      await accountService.updateDailyLimit('acc-1', 50000000n, admin);
      expect(limitWrite().data).toEqual({ dailyLimit: 50000000n, bankLimitCeiling: 50000000n });
      expect(mockPrisma.auditLog.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          action: 'DAILY_LIMIT_CHANGED',
          details: { from: '20000', to: '50000000', bankLimitCeiling: { from: '20000', to: '50000000' } },
        })
      );

      // Same limit, but no ceiling yet: recorded (not a no-op), so the owner can no longer raise it
      mockPrisma.bankAccount.updateMany.mockClear();
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      await accountService.updateDailyLimit('acc-1', 10000000n, admin);
      expect(limitWrite().data).toEqual({ dailyLimit: 10000000n, bankLimitCeiling: 10000000n });

      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ customerId: 'admin-user-id', dailyLimit: 20000n, bankLimitCeiling: 20000n }));
      await expect(accountService.updateDailyLimit('acc-1', 30000n, admin)).rejects.toThrow(ForbiddenError);
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

    it('SAME VERSION, LEDGER STRICTER: never loosened automatically (alert instead)', async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValueOnce([account({ status: AccountStatus.ACTIVE })]).mockResolvedValue([]);
      mockLedger.getAccounts.mockResolvedValue([
        { id: 'acc-1', isActive: false, closed: false, dailyLimitPaise: '10000000', balanceInPaise: '0', controlVersion: 3 },
      ]);
      expect((await accountService.reconcileWithLedger()).repaired).toBe(0);
      expect(mockLedger.updateAccount).not.toHaveBeenCalled();
    });

    it('SAME VERSION, LEDGER LOOSER: repaired with a freshly reserved version', async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValueOnce([account({ status: AccountStatus.FROZEN })]).mockResolvedValue([]);
      mockLedger.getAccounts.mockResolvedValue([
        { id: 'acc-1', isActive: true, closed: false, dailyLimitPaise: '10000000', balanceInPaise: '0', controlVersion: 3 },
      ]);
      expect((await accountService.reconcileWithLedger()).repaired).toBe(1);
      expect(mockLedger.updateAccount).toHaveBeenCalledWith('acc-1', { isActive: false, dailyLimitPaise: '10000000', version: 4 });
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

  describe('staff access log', () => {
    it('a staff read of an account is recorded; the owner reading their own is not', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      await accountService.viewAccount('acc-1', support);
      expect(mockPrisma.staffAccessLog.create).toHaveBeenCalledWith({
        data: { actorId: 'support-user-id', actorRole: 'SUPPORT', customerId: 'alice-cust-id', accountId: 'acc-1', action: 'VIEW_ACCOUNT' },
      });
      mockPrisma.staffAccessLog.create.mockClear();
      await accountService.viewAccount('acc-1', alice);
      expect(mockPrisma.staffAccessLog.create).not.toHaveBeenCalled();
    });

    it('NO READ WITHOUT A LOG: if the access log cannot be written, the data is not returned', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account());
      mockPrisma.staffAccessLog.create.mockRejectedValue(new Error('db down'));
      await expect(accountService.viewAccount('acc-1', support)).rejects.toThrow('db down');
    });

    it("staff listing a customer's accounts is recorded; customers always get their own list", async () => {
      mockPrisma.bankAccount.findMany.mockResolvedValue([account()]);
      await accountService.listAccounts(support, 'alice-cust-id');
      expect(mockPrisma.bankAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'alice-cust-id' } }));
      expect(mockPrisma.staffAccessLog.create).toHaveBeenCalledWith({
        data: { actorId: 'support-user-id', actorRole: 'SUPPORT', customerId: 'alice-cust-id', accountId: null, action: 'LIST_ACCOUNTS' },
      });

      mockPrisma.staffAccessLog.create.mockClear();
      await accountService.listAccounts(bob, 'alice-cust-id');
      expect(mockPrisma.bankAccount.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { customerId: 'bob-intruder-id' } }));
      // Staff listing their own accounts is a customer read
      await accountService.listAccounts(support);
      expect(mockPrisma.bankAccount.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { customerId: 'support-user-id' } }));
      expect(mockPrisma.staffAccessLog.create).not.toHaveBeenCalled();
    });

    it('lookup by account number is recorded; an unknown number is a 404', async () => {
      mockPrisma.bankAccount.findUnique.mockResolvedValue(account({ accountNumber: '200000000006' }));
      const found = await accountService.lookupByAccountNumber('200000000006', support);
      expect(found.id).toBe('acc-1');
      expect(mockPrisma.bankAccount.findUnique).toHaveBeenCalledWith({ where: { accountNumber: '200000000006' } });
      expect(mockPrisma.staffAccessLog.create).toHaveBeenCalledWith({
        data: { actorId: 'support-user-id', actorRole: 'SUPPORT', customerId: 'alice-cust-id', accountId: 'acc-1', action: 'LOOKUP_ACCOUNT' },
      });

      mockPrisma.bankAccount.findUnique.mockResolvedValue(null);
      await expect(accountService.lookupByAccountNumber('200000000014', support)).rejects.toThrow(NotFoundError);
    });
  });
});
