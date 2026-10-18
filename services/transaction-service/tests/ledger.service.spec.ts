import crypto from 'crypto';
import { LedgerService, startOfIstDay } from '../src/services/ledger.service';
import { TellerService } from '../src/services/teller.service';
import { BeneficiaryService } from '../src/services/beneficiary.service';
import { LedgerPolicy, istBusinessDate } from '../src/services/ledger-core';
import { IdempotencyService } from '../src/services/idempotency.service';
import {
  InsufficientFundsError,
  SameAccountTransferError,
  InvalidAmountError,
  NotFoundError,
  DailyLimitExceededError,
  AccountInactiveError,
  IdempotencyKeyReuseError,
} from '../src/errors';
import { AuthenticatedUser, ForbiddenError, ConflictError, HttpError } from '@banksphere/common';

const alice: AuthenticatedUser = { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER', mfa: true };
const aliceNoMfa: AuthenticatedUser = { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER', mfa: false };
const mallory: AuthenticatedUser = { id: 'mallory', email: 'mallory@bank.com', role: 'CUSTOMER' };
const teller: AuthenticatedUser = { id: 'teller', email: 'teller@bank.com', role: 'TELLER', mfa: true };
const checker: AuthenticatedUser = { id: 'checker', email: 'checker@bank.com', role: 'BANK_ADMIN', mfa: true };
const admin: AuthenticatedUser = { id: 'admin', email: 'admin@bank.com', role: 'BANK_ADMIN', mfa: true };

const policy: LedgerPolicy = {
  singleApprovalLimit: 20_000_000n,
  tellerDailyLimit: 100_000_000n,
  customerDailyOutflowLimit: 50_000_000n,
  approvalTtlHours: 24,
  stepUpThreshold: 10_000_000n,
  beneficiaryCoolingMinutes: 60,
  newBeneficiaryLimit: 5_000_000n,
  withdrawalCodeTtlMinutes: 15,
};

const row = (id: string, balance: bigint, customer: string, extra: Partial<any> = {}) => ({
  id,
  kind: 'CUSTOMER',
  balance,
  is_active: true,
  closed_at: null,
  account_number: `10010000000${id.slice(-1)}`,
  customer_id: customer,
  currency: 'INR',
  daily_limit: 10_000_000n,
  ...extra,
});

const DRAWER = row('drawer-teller', 0n, 'teller', { kind: 'TELLER_CASH', account_number: 'DRAWER-teller', daily_limit: 900_000_000_000_000_000n });
const openSession = () => ({ id: 'sess-1', tellerId: 'teller', status: 'OPEN', businessDate: istBusinessDate(), drawerAccountId: DRAWER.id });

function buildPrisma(rows: any[], owners: Record<string, string>) {
  const all = [...rows, DRAWER];
  const prisma: any = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
      if (sql.includes('cash_operations')) return Promise.resolve([{ id: 'op-1' }]);
      return Promise.resolve(all);
    }),
    $executeRaw: jest.fn(),
    transaction: {
      create: jest.fn(({ data }: any) => ({ id: 'tx-1', createdAt: new Date(), ...data })),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
    },
    ledgerEntry: {
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
      findMany: jest.fn(),
    },
    ledgerAccount: {
      update: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.kind === 'TELLER_CASH' ? { id: DRAWER.id } : null)),
      findUnique: jest.fn(({ where }: any) => {
        if (where.accountNumber) {
          const match = rows.find((r) => r.account_number === where.accountNumber);
          return Promise.resolve(match ? { id: match.id, customerId: match.customer_id, kind: match.kind, isActive: match.is_active, closedAt: match.closed_at } : null);
        }
        const owner = owners[where.id];
        return Promise.resolve(owner ? { id: where.id, customerId: owner, kind: 'CUSTOMER', isActive: true, closedAt: null } : null);
      }),
    },
    beneficiary: {
      // An established beneficiary (active for over a day) unless a test says otherwise
      findUnique: jest.fn().mockResolvedValue({ id: 'b1', revokedAt: null, activatesAt: new Date(Date.now() - 2 * 86400_000) }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }: any) => ({ id: 'b-new', createdAt: new Date(), ...data })),
    },
    tellerSession: { findFirst: jest.fn().mockResolvedValue(openSession()) },
    withdrawalAuthorization: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn(), count: jest.fn().mockResolvedValue(1) },
    cashOperation: {
      create: jest.fn(({ data }: any) => ({ id: data.id ?? 'op-1', createdAt: new Date(), ...data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
    },
  };
  prisma.$transaction = jest.fn((cb: any) => cb(prisma));
  return prisma;
}

describe('LedgerService: transfers', () => {
  it('rejects zero / negative amounts and same-account transfers', async () => {
    const svc = new LedgerService(buildPrisma([], {}), policy);
    for (const amountInPaise of [0n, -500n]) {
      await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise }, alice)).rejects.toThrow(InvalidAmountError);
    }
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-1', amountInPaise: 1n }, alice)).rejects.toThrow(SameAccountTransferError);
  });

  it('THEFT: nobody but the owner can move money out (not even an administrator)', async () => {
    const prisma = buildPrisma([row('acc-1', 50_000n, 'alice'), row('acc-2', 0n, 'bob')], { 'acc-1': 'alice', 'acc-2': 'bob' });
    const svc = new LedgerService(prisma, policy);
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 1n }, mallory)).rejects.toThrow(NotFoundError);
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 1n }, admin)).rejects.toThrow(NotFoundError);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('STEP-UP: large transfers need an MFA-authenticated session', async () => {
    const prisma = buildPrisma([row('acc-1', 90_000_000n, 'alice', { daily_limit: 90_000_000n }), row('acc-2', 0n, 'bob')], { 'acc-1': 'alice', 'acc-2': 'bob' });
    const err: any = await new LedgerService(prisma, policy)
      .executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 10_000_000n }, aliceNoMfa)
      .catch((e) => e);
    expect(err.errorCode).toBe('STEP_UP_REQUIRED');
  });

  it("ORACLE: checks the caller's own funds before revealing anything about the destination", async () => {
    const svc = new LedgerService(buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' }), policy);
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountNumber: '999999999999', amountInPaise: 100n }, alice)).rejects.toThrow(InsufficientFundsError);
  });

  it('ORACLE: missing, frozen, closed and teller-drawer destinations all give the same INVALID_DESTINATION', async () => {
    const destinations = [
      undefined,
      row('acc-2', 0n, 'bob', { is_active: false }),
      row('acc-2', 0n, 'bob', { closed_at: new Date() }),
      row('acc-2', 0n, 'teller', { kind: 'TELLER_CASH' }),
    ];
    for (const dest of destinations) {
      const rows = dest ? [row('acc-1', 50_000n, 'alice'), dest] : [row('acc-1', 50_000n, 'alice')];
      const svc = new LedgerService(buildPrisma(rows, { 'acc-1': 'alice', 'acc-2': 'bob' }), policy);
      const err: any = await svc
        .executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: dest ? 'acc-2' : 'acc-9', amountInPaise: 100n }, alice)
        .catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.errorCode).toBe('INVALID_DESTINATION');
    }
  });

  it('a frozen source account cannot send', async () => {
    const svc = new LedgerService(buildPrisma([row('acc-1', 50_000n, 'alice', { is_active: false }), row('acc-2', 0n, 'bob')], { 'acc-1': 'alice' }), policy);
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 1n }, alice)).rejects.toThrow(AccountInactiveError);
  });

  it('DAILY LIMIT: per-account and per-customer (across all accounts) limits are enforced', async () => {
    const prisma = buildPrisma([row('acc-1', 90_000_000n, 'alice', { daily_limit: 1_000_000n }), row('acc-2', 0n, 'bob')], { 'acc-1': 'alice' });
    prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amount: 900_000n } }).mockResolvedValueOnce({ _sum: { amount: 900_000n } });
    await expect(new LedgerService(prisma, policy).executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 200_000n }, alice)).rejects.toThrow(DailyLimitExceededError);

    const prisma2 = buildPrisma([row('acc-1', 90_000_000n, 'alice', { daily_limit: 90_000_000n }), row('acc-2', 0n, 'bob')], { 'acc-1': 'alice' });
    prisma2.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amount: 0n } }).mockResolvedValueOnce({ _sum: { amount: 49_000_000n } });
    await expect(new LedgerService(prisma2, policy).executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 2_000_000n }, alice)).rejects.toThrow('across all your accounts');
  });

  it('PAYEE CONTROLS: third-party transfers need a beneficiary that has finished cooling off, capped in its first day', async () => {
    const rows = [row('acc-1', 50_000_000n, 'alice', { daily_limit: 50_000_000n }), row('acc-2', 0n, 'bob')];
    const transfer = (prisma: any, amountInPaise: bigint) =>
      new LedgerService(prisma, policy)
        .executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise }, alice)
        .catch((e: any) => e.errorCode);

    const none = buildPrisma(rows, { 'acc-1': 'alice' });
    none.beneficiary.findUnique.mockResolvedValue(null);
    expect(await transfer(none, 1_000n)).toBe('BENEFICIARY_REQUIRED');

    const cooling = buildPrisma(rows, { 'acc-1': 'alice' });
    cooling.beneficiary.findUnique.mockResolvedValue({ revokedAt: null, activatesAt: new Date(Date.now() + 3600_000) });
    expect(await transfer(cooling, 1_000n)).toBe('BENEFICIARY_COOLING_OFF');

    const fresh = buildPrisma(rows, { 'acc-1': 'alice' });
    fresh.beneficiary.findUnique.mockResolvedValue({ revokedAt: null, activatesAt: new Date(Date.now() - 3600_000) });
    fresh.transaction.aggregate.mockResolvedValue({ _sum: { amount: 4_000_000n } });
    expect(await transfer(fresh, 2_000_000n)).toBe('NEW_BENEFICIARY_LIMIT');
  });

  it('transfers between the customer\'s own accounts need no beneficiary', async () => {
    const prisma = buildPrisma([row('acc-1', 10_000n, 'alice'), row('acc-2', 0n, 'alice')], { 'acc-1': 'alice', 'acc-2': 'alice' });
    prisma.beneficiary.findUnique.mockResolvedValue(null);
    const result = await new LedgerService(prisma, policy).executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 1_000n }, aliceNoMfa);
    expect(result.amountInPaise).toBe('1000');
  });

  it('posts balanced double entries, serialises per customer and stages an outbox event', async () => {
    const prisma = buildPrisma([row('acc-1', 10_000n, 'alice'), row('acc-2', 2_000n, 'bob')], { 'acc-1': 'alice', 'acc-2': 'bob' });
    const result = await new LedgerService(prisma, policy).executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 3_000n }, alice);

    expect(result.amountInPaise).toBe('3000');
    expect(prisma.$queryRaw.mock.calls.some(([s]: any) => s.join('').includes('pg_advisory_xact_lock'))).toBe(true);
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ accountId: 'acc-1', entryType: 'DEBIT', balanceAfter: 7_000n }) });
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ accountId: 'acc-2', entryType: 'CREDIT', balanceAfter: 5_000n }) });
    expect(prisma.outboxEvent.create.mock.calls[0][0].data.payload).toEqual(expect.objectContaining({ sourceCustomerId: 'alice', destinationCustomerId: 'bob' }));
  });
});

describe('TellerService: cash operations (drawer, session, maker-checker)', () => {
  it('SELF-DEALING: staff cannot deposit into (or withdraw from) their own account', async () => {
    const svc = new TellerService(buildPrisma([row('acc-t', 0n, 'teller')], { 'acc-t': 'teller' }), policy);
    await expect(svc.requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-t', amountInPaise: 100n }, teller)).rejects.toThrow(ForbiddenError);
  });

  it('NO SESSION: cash can only be handled inside an open teller session for today', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.tellerSession.findFirst.mockResolvedValue(null);
    const err: any = await new TellerService(prisma, policy)
      .requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 100n }, teller)
      .catch((e) => e);
    expect(err.errorCode).toBe('NO_TELLER_SESSION');

    prisma.tellerSession.findFirst.mockResolvedValue({ ...openSession(), businessDate: '2000-01-01' });
    const stale: any = await new TellerService(prisma, policy)
      .requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 100n }, teller)
      .catch((e) => e);
    expect(stale.errorCode).toBe('STALE_TELLER_SESSION');
  });

  it('DOUBLE ENTRY: a deposit debits the teller drawer and credits the customer', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    const result = await new TellerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 100_000n }, teller);
    expect(result.status).toBe('EXECUTED');
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ accountId: DRAWER.id, entryType: 'DEBIT', balanceAfter: 100_000n }) });
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ accountId: 'acc-1', entryType: 'CREDIT', balanceAfter: 100_000n }) });
    expect(prisma.auditLog.create.mock.calls.at(-1)[0].data.action).toBe('CASH_DEPOSIT_EXECUTED');
    expect(prisma.outboxEvent.create.mock.calls[0][0].data.payload).toEqual(expect.objectContaining({ initiatedBy: 'teller', type: 'DEPOSIT' }));
  });

  it('MINTING: a deposit above the single-approval limit only creates a pending request', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    const result = await new TellerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 999_999_999n }, teller);
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(prisma.ledgerAccount.update).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('MINTING: many small deposits beyond the teller daily budget also need approval', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 99_000_000n } });
    const result = await new TellerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 5_000_000n }, teller);
    expect(result.status).toBe('PENDING_APPROVAL');
  });

  it('WITHDRAWAL: needs the customer\'s single-use code for that exact amount', async () => {
    const prisma = buildPrisma([row('acc-1', 1_000_000n, 'alice')], { 'acc-1': 'alice' });
    const svc = new TellerService(prisma, policy);
    const withdraw = (authorizationCode?: string, amountInPaise = 50_000n) =>
      svc.requestCashOperation({ type: 'WITHDRAWAL', accountId: 'acc-1', amountInPaise, authorizationCode }, teller).catch((e: any) => e);

    expect((await withdraw(undefined)).errorCode).toBe('WITHDRAWAL_NOT_AUTHORISED');

    const authId = 'auth-1';
    const codeHash = crypto.createHash('sha256').update(`${authId}:12345678`).digest('hex');
    prisma.withdrawalAuthorization.findFirst.mockResolvedValue({ id: authId, amount: 50_000n, codeHash, createdAt: new Date() });
    expect((await withdraw('87654321')).errorCode).toBe('WITHDRAWAL_NOT_AUTHORISED');
    expect((await withdraw('12345678', 60_000n)).errorCode).toBe('WITHDRAWAL_NOT_AUTHORISED');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();

    const ok = await withdraw('12345678');
    expect(ok.status).toBe('EXECUTED');
    expect(prisma.withdrawalAuthorization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: authId, usedAt: null } })
    );
    // Customer account debited, drawer credited
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ accountId: 'acc-1', entryType: 'DEBIT' }) });
  });

  it('BRUTE FORCE: repeated wrong withdrawal codes burn every outstanding code for the account', async () => {
    const prisma = buildPrisma([row('acc-1', 1_000_000n, 'alice')], { 'acc-1': 'alice' });
    prisma.withdrawalAuthorization.findFirst.mockResolvedValue({ id: 'auth-1', amount: 50_000n, codeHash: 'x'.repeat(64), createdAt: new Date() });
    prisma.auditLog.count.mockResolvedValue(5);
    await new TellerService(prisma, policy)
      .requestCashOperation({ type: 'WITHDRAWAL', accountId: 'acc-1', amountInPaise: 50_000n, authorizationCode: '00000000' }, teller)
      .catch(() => {});
    expect(prisma.withdrawalAuthorization.updateMany).toHaveBeenCalledWith({ where: { accountId: 'acc-1', usedAt: null }, data: { usedAt: expect.any(Date) } });
  });

  it('the requester cannot approve their own request; a different admin can', async () => {
    const pending = { id: 'op-1', type: 'DEPOSIT', status: 'PENDING_APPROVAL', accountId: 'acc-1', amount: 30_000_000n, requestedBy: 'teller', createdAt: new Date(), description: null };
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.findUniqueOrThrow.mockResolvedValue(pending);
    const svc = new TellerService(prisma, policy);

    await expect(svc.approveCashOperation('op-1', teller)).rejects.toThrow(ForbiddenError);
    const result = await svc.approveCashOperation('op-1', checker);
    expect(result.status).toBe('EXECUTED');
    expect(prisma.cashOperation.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ status: 'EXECUTED', approvedBy: 'checker' }));
  });

  it('an already-decided request cannot be approved twice', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.findUniqueOrThrow.mockResolvedValue({ id: 'op-1', status: 'EXECUTED', requestedBy: 'teller', accountId: 'acc-1', createdAt: new Date() });
    await expect(new TellerService(prisma, policy).approveCashOperation('op-1', checker)).rejects.toThrow(ConflictError);
  });

  it('a teller cannot sign off their own session', async () => {
    const prisma = buildPrisma([], {});
    prisma.tellerSession.findUnique = jest.fn().mockResolvedValue({ ...openSession(), status: 'CLOSED' });
    await expect(new TellerService(prisma, policy).signOffSession({ ...teller, role: 'BANK_ADMIN' }, 'sess-1')).rejects.toThrow(ForbiddenError);
  });
});

describe('BeneficiaryService', () => {
  it('adding with an MFA session activates immediately; without one there is a cooling-off period', async () => {
    const rows = [row('acc-2', 0n, 'bob', { account_number: '100100000002' })];
    const prisma = buildPrisma(rows, {});
    const svc = new BeneficiaryService(prisma, policy);
    await svc.add(alice, '100100000002', 'Bob');
    const withMfa = prisma.beneficiary.create.mock.calls[0][0].data.activatesAt.getTime();
    expect(withMfa).toBeLessThanOrEqual(Date.now());

    await svc.add(aliceNoMfa, '100100000002', 'Bob');
    const withoutMfa = prisma.beneficiary.create.mock.calls[1][0].data.activatesAt.getTime();
    expect(withoutMfa).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it('a customer cannot add their own account or an unknown account', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice', { account_number: '100100000001' })], {});
    const svc = new BeneficiaryService(prisma, policy);
    await expect(svc.add(alice, '100100000001', 'Me')).rejects.toThrow();
    await expect(svc.add(alice, '999999999999', 'Nobody')).rejects.toThrow();
    expect(prisma.beneficiary.create).not.toHaveBeenCalled();
  });
});

describe('LedgerService: account control state', () => {
  it('refuses to close an account with money, under the row lock', async () => {
    const prisma = buildPrisma([row('acc-1', 5n, 'alice')], {});
    await expect(new LedgerService(prisma, policy).closeAccount('acc-1', 2)).rejects.toThrow('balance must be zero');
    expect(prisma.ledgerAccount.update).not.toHaveBeenCalled();
  });
});

describe('startOfIstDay', () => {
  it('returns the UTC instant of the most recent IST midnight', () => {
    expect(startOfIstDay(new Date('2026-01-01T20:00:00Z')).toISOString()).toBe('2026-01-01T18:30:00.000Z');
    expect(startOfIstDay(new Date('2026-01-01T10:00:00Z')).toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });
});

describe('IdempotencyService', () => {
  const ctx = { userId: 'alice', key: 'key-12345678', endpoint: 'transfer', requestHash: 'h1' };

  it('produces the same hash regardless of key order', () => {
    const service = new IdempotencyService({} as any);
    expect(service.generateRequestHash({ a: 1, b: 2 })).toBe(service.generateRequestHash({ b: 2, a: 1 }));
  });

  it('rejects reuse of a key with a different payload', async () => {
    const prisma: any = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue({ ...ctx, requestHash: 'different', status: 'COMPLETED', expiresAt: new Date(Date.now() + 60000) }) },
    };
    await expect(new IdempotencyService(prisma).execute(ctx, jest.fn())).rejects.toThrow(IdempotencyKeyReuseError);
  });

  it('CONCURRENCY: losing the unique-key race replays the winner instead of moving money twice', async () => {
    const winner = { ...ctx, status: 'COMPLETED', statusCode: 201, responseBody: { success: true, data: { transactionId: 'tx-1' } }, expiresAt: new Date(Date.now() + 60000) };
    const prisma: any = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner) },
      $transaction: jest.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' })),
    };
    const result = await new IdempotencyService(prisma).execute(ctx, jest.fn());
    expect(result.replayed).toBe(true);
    expect(result.responseBody.data.transactionId).toBe('tx-1');
  });

  it('stores the status code chosen by the work (202 for pending approvals)', async () => {
    const prisma: any = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction = jest.fn((cb: any) => cb(prisma));
    const result = await new IdempotencyService(prisma).execute(ctx, async () => ({ statusCode: 202, data: { status: 'PENDING_APPROVAL' } }));
    expect(result.statusCode).toBe(202);
    expect(prisma.idempotencyRecord.update.mock.calls[0][0].data.statusCode).toBe(202);
  });
});
