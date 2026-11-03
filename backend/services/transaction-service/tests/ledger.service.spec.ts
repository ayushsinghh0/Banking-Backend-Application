import crypto from 'crypto';
import { LedgerService, startOfIstDay } from '../src/services/ledger.service';
import { TellerService } from '../src/services/teller.service';
import { BeneficiaryService } from '../src/services/beneficiary.service';
import { LedgerPolicy, defaultLedgerPolicy, envNumber, istBusinessDate } from '../src/services/ledger-core';
import { IdempotencyService } from '../src/services/idempotency.service';
import { TransactionController } from '../src/controllers/transaction.controller';
import {
  InsufficientFundsError,
  SameAccountTransferError,
  InvalidAmountError,
  NotFoundError,
  DailyLimitExceededError,
  AccountInactiveError,
  IdempotencyKeyReuseError,
} from '../src/errors';
import { AuthenticatedUser, ForbiddenError, ConflictError, HttpError, logger } from '@banksphere/common';

const NOW = () => Math.floor(Date.now() / 1000);
// Fresh TOTP verification on a factor enrolled two days ago: strong, recent authentication
const alice: AuthenticatedUser = { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER', mfa: true, stepUpAt: NOW(), mfaSince: NOW() - 2 * 86400 };
// MFA session, but the TOTP check was an hour ago (e.g. a refreshed or stolen long-lived session)
const aliceStale: AuthenticatedUser = { ...alice, stepUpAt: NOW() - 3600 };
// Factor enrolled a minute ago (e.g. by an attacker holding a phished password)
const aliceNewFactor: AuthenticatedUser = { ...alice, mfaSince: NOW() - 60 };
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
  withdrawalCodeStepUpThreshold: 2_500_000n,
  stepUpMaxAgeSeconds: 300,
  mfaFactorMinAgeHours: 24,
  maxNewBeneficiariesPerDay: 10,
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
const VAULT = row('vault', 0n, 'BANK', { kind: 'VAULT_CASH', account_number: 'VAULT-CASH' });
const SUSPENSE = row('suspense', 0n, 'BANK', { kind: 'CASH_SUSPENSE', account_number: 'CASH-SUSPENSE' });
const openSession = () => ({
  id: 'sess-1',
  tellerId: 'teller',
  status: 'OPEN',
  businessDate: istBusinessDate(),
  drawerAccountId: DRAWER.id,
  openingFloat: 0n,
  declaredClosing: null,
  expectedClosing: null,
  discrepancy: null,
});

function buildPrisma(rows: any[], owners: Record<string, string>, drawerBalance = 0n) {
  const drawer = { ...DRAWER, balance: drawerBalance };
  const all = [...rows, drawer, VAULT, SUSPENSE];
  const prisma: any = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
      if (sql.includes('cash_operations')) return Promise.resolve([{ id: 'op-1' }]);
      return Promise.resolve(all);
    }),
    $executeRaw: jest.fn(),
    // Audit chain head (lockAuditChain and the seq lookup): an empty chain unless a test says otherwise
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
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
      findFirst: jest.fn(({ where }: any) => Promise.resolve(where.kind === 'TELLER_CASH' ? { id: DRAWER.id, balance: drawerBalance } : null)),
      upsert: jest.fn(({ where }: any) => Promise.resolve(where.accountNumber === 'VAULT-CASH' ? { id: VAULT.id } : { id: SUSPENSE.id })),
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
      update: jest.fn(({ where, data }: any) => ({ id: where.id, createdAt: new Date(), ...data })),
    },
    tellerSession: {
      findFirst: jest.fn().mockResolvedValue(openSession()),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }: any) => ({ id: 'sess-1', ...data })),
      update: jest.fn(({ data }: any) => ({ ...openSession(), ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    withdrawalAuthorization: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn(), count: jest.fn().mockResolvedValue(1) },
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    cashOperation: {
      create: jest.fn(({ data }: any) => ({ id: data.id ?? 'op-1', createdAt: new Date(), ...data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
    },
  };
  prisma.$transaction = jest.fn((cb: any) => cb(prisma));
  return prisma;
}

/**
 * Gives a mocked client real transaction semantics for the listed models: writes made through `tx` only
 * count once the callback resolves (commit) and are dropped when it throws (rollback). A call on the ROOT
 * client while a transaction is open would need a second pooled connection; those are listed in
 * `secondConnection`. Configure the mocks as usual (on `prisma`), before or after calling this.
 */
function transactional(
  prisma: any,
  models = ['auditLog', 'tellerSession', 'outboxEvent', 'beneficiary', 'withdrawalAuthorization', 'idempotencyRecord']
) {
  const viaTx = new Set<unknown>();
  const rolledBack = new Set<unknown>();
  const secondConnection: string[] = [];
  const mocks = () =>
    models.flatMap((m) => Object.entries<any>(prisma[m] ?? {}).filter(([, f]) => f?.mock).map(([op, f]) => [`${m}.${op}`, f] as const));
  prisma.$transaction = jest.fn(async (cb: any) => {
    const started = new Map(mocks().map(([name, f]) => [name, f.mock.calls.length]));
    const mine: unknown[] = [];
    const tx = Object.create(prisma);
    for (const m of models) {
      tx[m] = new Proxy(
        {},
        {
          get: (_t, op: string) => (args: any = {}) => {
            viaTx.add(args);
            mine.push(args);
            return prisma[m][op](args);
          },
        }
      );
    }
    try {
      return await cb(tx);
    } catch (err) {
      mine.forEach((a) => rolledBack.add(a));
      throw err;
    } finally {
      for (const [name, f] of mocks()) {
        for (const [args] of f.mock.calls.slice(started.get(name) ?? 0)) if (!viaTx.has(args)) secondConnection.push(name);
      }
    }
  });
  const committed = (model: string, op: string): any[] =>
    (prisma[model][op].mock.calls as any[][]).map(([a]) => a).filter((a) => !rolledBack.has(a));
  return { secondConnection, committed, audits: () => committed('auditLog', 'create').map((a) => a.data.action) };
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

  it('STEP-UP: large transfers need a RECENT TOTP check on an ESTABLISHED factor', async () => {
    const prisma = buildPrisma([row('acc-1', 90_000_000n, 'alice', { daily_limit: 90_000_000n }), row('acc-2', 0n, 'alice')], { 'acc-1': 'alice', 'acc-2': 'alice' });
    const send = (actor: AuthenticatedUser) =>
      new LedgerService(prisma, policy)
        .executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 10_000_000n }, actor)
        .then(() => 'OK', (e) => e.errorCode);
    expect(await send(aliceNoMfa)).toBe('STEP_UP_REQUIRED');
    expect(await send(aliceStale)).toBe('STEP_UP_REQUIRED'); // MFA session, but not verified recently
    expect(await send(aliceNewFactor)).toBe('STEP_UP_REQUIRED'); // factor enrolled minutes ago
    expect(await send(alice)).toBe('OK');
  });

  it('ENUMERATION: without a registered payee, existing and non-existent accounts give the same answer', async () => {
    const prisma = buildPrisma([row('acc-1', 50_000n, 'alice'), row('acc-2', 0n, 'bob', { account_number: '100100000002' })], { 'acc-1': 'alice' });
    prisma.beneficiary.findUnique.mockResolvedValue(null);
    const svc = new LedgerService(prisma, policy);
    const code = (destinationAccountNumber: string) =>
      svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountNumber, amountInPaise: 1n }, alice).catch((e: any) => e.errorCode);
    expect(await code('100100000002')).toBe('BENEFICIARY_REQUIRED'); // exists
    expect(await code('999999999999')).toBe('BENEFICIARY_REQUIRED'); // doesn't
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

  it('NEW PAYEE CAP: removing and re-adding a payee does not reset it (trailing 24h), and it is summed before the row locks', async () => {
    const rows = [row('acc-1', 50_000_000n, 'alice', { daily_limit: 50_000_000n }), row('acc-2', 0n, 'bob')];
    const prisma = buildPrisma(rows, { 'acc-1': 'alice' });
    prisma.beneficiary.findUnique.mockResolvedValue({ id: 'b1', revokedAt: null, activatesAt: new Date(Date.now() - 10 * 60_000) }); // re-added 10 min ago
    prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 4_000_000n } }); // sent before the re-add
    const err: any = await new LedgerService(prisma, policy)
      .executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 2_000_000n }, alice)
      .catch((e) => e);
    expect(err.errorCode).toBe('NEW_BENEFICIARY_LIMIT');

    const [{ where }] = prisma.transaction.aggregate.mock.calls[0];
    expect(where).toEqual({ type: 'TRANSFER', initiatedBy: 'alice', destinationAccountId: 'acc-2', createdAt: { gte: expect.any(Date) } });
    expect(Math.abs(Date.now() - 24 * 3600_000 - where.createdAt.gte.getTime())).toBeLessThan(5_000);
    const rowLock = prisma.$queryRaw.mock.calls.findIndex(([s]: any) => s.join('').includes('FOR UPDATE'));
    expect(prisma.transaction.aggregate.mock.invocationCallOrder[0]).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[rowLock]);

    // An established payee (activated over a day ago) is not summed at all
    const established = buildPrisma(rows, { 'acc-1': 'alice' });
    await new LedgerService(established, policy).executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 2_000_000n }, alice);
    expect(established.transaction.aggregate).not.toHaveBeenCalled();
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

  it('POOL: a wrong code needs one connection at a time; the failure is recorded after the money transaction rolled back', async () => {
    const ACC = '11111111-1111-4111-8111-111111111111';
    const issuedAt = new Date(Date.now() - 60_000);
    const prisma = buildPrisma([row(ACC, 1_000_000n, 'alice')], { [ACC]: 'alice' });
    prisma.withdrawalAuthorization.findFirst.mockResolvedValue({ id: 'auth-1', amount: 50_000n, codeHash: 'x'.repeat(64), createdAt: issuedAt });
    prisma.auditLog.count.mockResolvedValue(4); // four earlier failures since the code was issued: this one is the fifth
    const db = transactional(prisma);
    const tellerService = new TellerService(prisma, policy);
    const controller = new TransactionController({} as any, tellerService, {} as any, new IdempotencyService(prisma));
    const req: any = {
      user: teller,
      body: { accountId: ACC, amountInPaise: '50000', authorizationCode: '00000000' },
      header: (name: string) => (name === 'Idempotency-Key' ? 'withdraw-key-0001' : undefined),
    };
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const err: any = await new Promise((resolve) => controller.withdraw(req, res, resolve));

    expect(err.errorCode).toBe('WITHDRAWAL_NOT_AUTHORISED');
    expect(db.secondConnection).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // the refused withdrawal, then the failure record
    expect(db.committed('idempotencyRecord', 'create')).toEqual([]); // the claim rolled back: the key stays usable
    expect(db.audits()).toEqual(['WITHDRAWAL_CODE_FAILED']);
    expect(db.committed('auditLog', 'create')[0].data).toEqual(expect.objectContaining({ actorId: 'teller', targetId: ACC }));
    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: { action: 'WITHDRAWAL_CODE_FAILED', targetId: ACC, createdAt: { gte: issuedAt } } });
    expect(db.committed('withdrawalAuthorization', 'updateMany')).toEqual([{ where: { accountId: ACC, usedAt: null }, data: { usedAt: expect.any(Date) } }]);
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
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

  it('FLOAT: issued by a supervisor, booked vault -> drawer only when the teller counts the same amount', async () => {
    const prisma = buildPrisma([], {});
    prisma.tellerSession.findFirst.mockResolvedValue(null); // the teller has no unfinished session
    const svc = new TellerService(prisma, policy);
    await expect(svc.issueFloat(checker, 'checker', 100_000n)).rejects.toThrow(ForbiddenError);
    const issued = await svc.issueFloat(checker, 'teller', 100_000n);
    expect(issued.status).toBe('ISSUED');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled(); // nothing booked yet

    prisma.tellerSession.findFirst.mockResolvedValue({ ...openSession(), status: 'ISSUED', openingFloat: 100_000n, issuedBy: 'checker' });
    const wrong: any = await svc.acceptFloat(teller, 90_000n).catch((e) => e);
    expect(wrong.errorCode).toBe('FLOAT_MISMATCH');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();

    await svc.acceptFloat(teller, 100_000n);
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ accountId: DRAWER.id, entryType: 'DEBIT', amount: 100_000n }) });
    expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ accountId: VAULT.id, entryType: 'CREDIT', amount: 100_000n }) });
  });

  it('a float cannot be issued while the drawer still holds booked cash', async () => {
    const prisma = buildPrisma([], {}, 5_000n);
    prisma.tellerSession.findFirst.mockResolvedValue(null);
    const svc = new TellerService(prisma, policy);
    await expect(svc.issueFloat(checker, 'teller', 100_000n)).rejects.toThrow(ConflictError);
  });

  it('BLIND CLOSE: the teller is never told what the ledger expects', async () => {
    const prisma = buildPrisma([], {}, 150_000n);
    prisma.cashOperation.count = jest.fn().mockResolvedValue(0);
    const closed: any = await new TellerService(prisma, policy).closeSession(teller, 150_000n);
    expect(closed.status).toBe('CLOSED');
    expect(closed).not.toHaveProperty('expectedClosing');
    expect(closed).not.toHaveProperty('discrepancy');
  });

  it('SIGN-OFF: a second blind count must match; cash returns to the vault and a shortage goes to suspense', async () => {
    const prisma = buildPrisma([], {}, 100_500n);
    const closed = { ...openSession(), status: 'CLOSED', declaredClosing: 100_000n, openingFloat: 50_000n };
    prisma.tellerSession.findUniqueOrThrow.mockResolvedValue(closed);
    const svc = new TellerService(prisma, policy);

    await expect(svc.signOffSession({ ...teller, role: 'BANK_ADMIN' }, 'sess-1', 100_000n)).rejects.toThrow(ForbiddenError);
    const mismatch: any = await svc.signOffSession(checker, 'sess-1', 99_000n).catch((e) => e);
    expect(mismatch.errorCode).toBe('COUNT_MISMATCH');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();

    const done = await svc.signOffSession(checker, 'sess-1', 100_000n);
    expect(done.status).toBe('RECONCILED');
    expect(done.discrepancy).toBe('-500');
    const entries = prisma.ledgerEntry.create.mock.calls.map(([{ data }]: any) => [data.accountId, data.entryType, data.amount]);
    expect(entries).toEqual([
      [VAULT.id, 'DEBIT', 100_000n], // counted cash back into the vault
      [DRAWER.id, 'CREDIT', 100_000n],
      [SUSPENSE.id, 'DEBIT', 500n], // the missing cash, under investigation
      [DRAWER.id, 'CREDIT', 500n],
    ]);
  });

  it('a teller only sees the cash operations they requested; supervisors see them all', async () => {
    const prisma = buildPrisma([], {});
    const svc = new TellerService(prisma, policy);
    await svc.listCashOperations('EXECUTED', 20, 0, teller);
    expect(prisma.cashOperation.findMany.mock.calls.at(-1)[0].where).toEqual({ status: 'EXECUTED', requestedBy: 'teller' });
    await svc.listCashOperations(undefined, 20, 0, teller);
    expect(prisma.cashOperation.findMany.mock.calls.at(-1)[0].where).toEqual({ requestedBy: 'teller' });
    await svc.listCashOperations(undefined, 20, 0, checker);
    expect(prisma.cashOperation.findMany.mock.calls.at(-1)[0].where).toEqual({});
    await svc.listCashOperations('PENDING_APPROVAL', 20, 0, { ...checker, role: 'SUPPORT' });
    expect(prisma.cashOperation.findMany.mock.calls.at(-1)[0].where).toEqual({ status: 'PENDING_APPROVAL' });
  });

  it('WITHDRAWAL CODES: large codes need recent strong auth; every code is audited and emailed', async () => {
    const prisma = buildPrisma([row('acc-1', 9_000_000n, 'alice')], { 'acc-1': 'alice' });
    const svc = new TellerService(prisma, policy);
    const err: any = await svc.createWithdrawalCode(aliceNoMfa, 'acc-1', 3_000_000n).catch((e) => e);
    expect(err.errorCode).toBe('STEP_UP_REQUIRED');
    await svc.createWithdrawalCode(aliceNoMfa, 'acc-1', 100_000n); // small: fine without step-up
    expect(prisma.auditLog.create.mock.calls.at(-1)[0].data.action).toBe('WITHDRAWAL_CODE_CREATED');
    expect(prisma.outboxEvent.create.mock.calls.at(-1)[0].data.eventType).toBe('withdrawal.code.created.v1');
    await expect(svc.createWithdrawalCode(alice, 'acc-1', 3_000_000n)).resolves.toHaveProperty('authorizationCode');
  });
});

describe('TellerService: close-out, disputes and teller-facing views', () => {
  const TELLER_VIEW_FIELDS = ['acceptedAt', 'businessDate', 'closedAt', 'id', 'issuedBy', 'openedAt', 'openingFloat', 'signedOffAt', 'signedOffBy', 'status', 'tellerId'];
  const closedSession = (extra: Partial<any> = {}) => ({
    ...openSession(),
    status: 'CLOSED',
    declaredClosing: 100_000n,
    openingFloat: 50_000n,
    issuedBy: 'checker',
    disputedCount: null,
    disputedBy: null,
    disputedAt: null,
    ...extra,
  });

  it('BLIND COUNT: the session list hides the declared count, expected cash and any disputed count until sign-off', async () => {
    const prisma = buildPrisma([], {});
    prisma.tellerSession.findMany.mockResolvedValue([
      closedSession({ id: 's-closed', disputedCount: 99_000n, disputedBy: 'checker', disputedAt: new Date() }),
      closedSession({ id: 's-done', status: 'RECONCILED', expectedClosing: 100_500n, discrepancy: -500n }),
    ]);
    const [pending, done]: any[] = await new TellerService(prisma, policy).listSessions(undefined, 20, 0);
    for (const field of ['declaredClosing', 'expectedClosing', 'discrepancy', 'disputedCount']) expect(pending).not.toHaveProperty(field);
    expect(pending).toEqual(expect.objectContaining({ id: 's-closed', status: 'CLOSED', disputedBy: 'checker', drawerAccountId: DRAWER.id }));
    expect(done).toEqual(expect.objectContaining({ declaredClosing: '100000', expectedClosing: '100500', discrepancy: '-500' }));
  });

  it('AUDIT: float and closing-count mismatches are committed, although the request is refused', async () => {
    const prisma = buildPrisma([], {}, 100_500n);
    const db = transactional(prisma);
    const svc = new TellerService(prisma, policy);

    prisma.tellerSession.findFirst.mockResolvedValue({ ...openSession(), status: 'ISSUED', openingFloat: 100_000n });
    expect((await svc.acceptFloat(teller, 90_000n).catch((e) => e)).errorCode).toBe('FLOAT_MISMATCH');
    prisma.tellerSession.findUniqueOrThrow.mockResolvedValue(closedSession());
    expect((await svc.signOffSession(checker, 'sess-1', 99_000n).catch((e) => e)).errorCode).toBe('COUNT_MISMATCH');

    expect(db.audits()).toEqual(['TELLER_FLOAT_COUNT_MISMATCH', 'TELLER_COUNT_MISMATCH']);
    expect(db.committed('tellerSession', 'update').map((u) => u.data)).toEqual([
      { disputedCount: 99_000n, disputedBy: 'checker', disputedAt: expect.any(Date) },
    ]);
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('RE-DECLARE: until sign-off the teller can correct a closing count (POST /close again); the old figure stays in the audit', async () => {
    const prisma = buildPrisma([], {});
    prisma.tellerSession.findFirst.mockResolvedValue(closedSession());
    const view: any = await new TellerService(prisma, policy).closeSession(teller, 100_500n);
    expect(prisma.tellerSession.findFirst).toHaveBeenCalledWith({ where: { tellerId: 'teller', status: { in: ['OPEN', 'CLOSED'] } } });
    expect(prisma.tellerSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', status: 'CLOSED', declaredClosing: 100_000n },
      data: { declaredClosing: 100_500n },
    });
    expect(prisma.auditLog.create.mock.calls.at(-1)[0].data).toEqual(
      expect.objectContaining({ action: 'TELLER_CLOSING_REDECLARED', targetId: 'sess-1', details: { previous: '100000', counted: '100500' } })
    );
    expect(Object.keys(view).sort()).toEqual(TELLER_VIEW_FIELDS);

    // Signed off (or re-declared) in the meantime: the conditional update matches nothing
    prisma.tellerSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(new TellerService(prisma, policy).closeSession(teller, 100_700n)).rejects.toThrow(ConflictError);
  });

  it('DISPUTE: a second, DIFFERENT administrator with the same blind count settles a disputed declaration', async () => {
    const prisma = buildPrisma([], {}, 100_500n);
    transactional(prisma);
    let session: any = closedSession();
    prisma.tellerSession.findUniqueOrThrow.mockImplementation(() => Promise.resolve(session));
    prisma.tellerSession.update.mockImplementation(({ data }: any) => {
      session = { ...session, ...data };
      return Promise.resolve(session);
    });
    const warn = jest.spyOn(logger, 'warn');
    const svc = new TellerService(prisma, policy);
    const signOff = (who: AuthenticatedUser, count: bigint) => svc.signOffSession(who, 'sess-1', count).catch((e: any) => e);

    expect((await signOff(checker, 100_200n)).errorCode).toBe('COUNT_MISMATCH');
    expect(session).toEqual(expect.objectContaining({ disputedCount: 100_200n, disputedBy: 'checker' }));
    // The same supervisor can never supply both counts
    expect((await signOff(checker, 100_200n)).errorCode).toBe('COUNT_MISMATCH');
    // ...and the teller can never settle their own session
    expect(await signOff({ ...teller, role: 'BANK_ADMIN' }, 100_200n)).toBeInstanceOf(ForbiddenError);
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();

    const done: any = await signOff(admin, 100_200n);
    expect(done).toEqual(
      expect.objectContaining({ status: 'RECONCILED', declaredClosing: '100000', disputedCount: '100200', expectedClosing: '100500', discrepancy: '-300', signedOffBy: 'admin' })
    );
    const entries = prisma.ledgerEntry.create.mock.calls.map(([{ data }]: any) => [data.accountId, data.entryType, data.amount]);
    expect(entries).toEqual([
      [VAULT.id, 'DEBIT', 100_200n], // the supervisors' agreed count goes back to the vault
      [DRAWER.id, 'CREDIT', 100_200n],
      [SUSPENSE.id, 'DEBIT', 300n], // difference to the ledger, exactly as for an agreed close
      [DRAWER.id, 'CREDIT', 300n],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'TELLER_DECLARATION_DISPUTED', sessionId: 'sess-1' }), expect.any(String));
    warn.mockRestore();
  });

  it('DISPUTE: a third, different count does not settle anything; it replaces the recorded dispute', async () => {
    const prisma = buildPrisma([], {}, 100_500n);
    prisma.tellerSession.findUniqueOrThrow.mockResolvedValue(closedSession({ disputedCount: 100_200n, disputedBy: 'checker', disputedAt: new Date() }));
    const err: any = await new TellerService(prisma, policy).signOffSession(admin, 'sess-1', 100_300n).catch((e) => e);
    expect(err.errorCode).toBe('COUNT_MISMATCH');
    expect(prisma.tellerSession.update.mock.calls.at(-1)[0].data).toEqual({ disputedCount: 100_300n, disputedBy: 'admin', disputedAt: expect.any(Date) });
    expect(prisma.auditLog.create.mock.calls.at(-1)[0].data.details).toEqual(
      expect.objectContaining({ supervisorCount: '100300', previousDisputedCount: '100200', previousDisputedBy: 'checker' })
    );
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('RACES: accepting a float and closing a session are conditional on the state that was read', async () => {
    const prisma = buildPrisma([], {});
    const issued = { ...openSession(), status: 'ISSUED', openingFloat: 100_000n, openedAt: new Date('2026-10-27T03:00:00Z') };
    prisma.tellerSession.findFirst.mockResolvedValue(issued);
    prisma.tellerSession.updateMany.mockResolvedValue({ count: 0 }); // cancelled (or cancelled and reissued) meanwhile
    const svc = new TellerService(prisma, policy);
    await expect(svc.acceptFloat(teller, 100_000n)).rejects.toThrow(ConflictError);
    expect(prisma.tellerSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', status: 'ISSUED', openingFloat: 100_000n, openedAt: issued.openedAt },
      data: { status: 'OPEN', acceptedAt: expect.any(Date) },
    });

    prisma.tellerSession.findFirst.mockResolvedValue(openSession());
    await expect(svc.closeSession(teller, 0n)).rejects.toThrow(ConflictError); // closed twice at once
    expect(prisma.tellerSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sess-1', status: 'OPEN' },
      data: { status: 'CLOSED', declaredClosing: 0n, closedAt: expect.any(Date) },
    });
    expect(prisma.tellerSession.update).not.toHaveBeenCalled();
  });

  it('TELLER VIEWS: never the drawer account or any count; the issued float stays hidden until the teller has counted it', async () => {
    const prisma = buildPrisma([], {});
    const svc = new TellerService(prisma, policy);
    const full = { ...closedSession(), expectedClosing: 1n, discrepancy: 1n, disputedCount: 2n, disputedBy: 'checker', acceptedAt: new Date(), openedAt: new Date() };

    prisma.tellerSession.findFirst.mockResolvedValue({ ...full, status: 'ISSUED', openingFloat: 100_000n });
    const accepted: any = await svc.acceptFloat(teller, 100_000n);
    expect(Object.keys(accepted).sort()).toEqual(TELLER_VIEW_FIELDS);
    expect(accepted).toEqual(expect.objectContaining({ status: 'OPEN', openingFloat: '100000' }));

    prisma.tellerSession.findFirst.mockResolvedValue({ ...full, status: 'OPEN' });
    prisma.cashOperation.count.mockResolvedValue(0);
    const closed: any = await svc.closeSession(teller, 100_000n);
    expect(Object.keys(closed).sort()).toEqual(TELLER_VIEW_FIELDS);
    expect(closed.status).toBe('CLOSED');

    prisma.tellerSession.findUnique.mockResolvedValue({ ...full, status: 'ISSUED', openingFloat: 100_000n });
    const issued: any = await svc.currentSession(teller);
    expect(Object.keys(issued).sort()).toEqual(TELLER_VIEW_FIELDS);
    expect(issued.openingFloat).toBeNull(); // the acceptance count is blind too
  });

  it("CURRENT SESSION: today's session, else the latest unfinished one, else null", async () => {
    const prisma = buildPrisma([], {});
    const svc = new TellerService(prisma, policy);
    prisma.tellerSession.findUnique.mockResolvedValue({ ...closedSession(), status: 'RECONCILED' });
    expect((await svc.currentSession(teller))?.status).toBe('RECONCILED');
    expect(prisma.tellerSession.findUnique).toHaveBeenCalledWith({
      where: { tellerId_businessDate: { tellerId: 'teller', businessDate: istBusinessDate() } },
    });

    prisma.tellerSession.findUnique.mockResolvedValue(null);
    prisma.tellerSession.findFirst.mockResolvedValue({ ...closedSession(), businessDate: '2026-10-26' });
    expect((await svc.currentSession(teller))?.businessDate).toBe('2026-10-26');
    expect(prisma.tellerSession.findFirst).toHaveBeenLastCalledWith({
      where: { tellerId: 'teller', status: { in: ['ISSUED', 'OPEN', 'CLOSED'] } },
      orderBy: [{ businessDate: 'desc' }, { openedAt: 'desc' }],
    });

    prisma.tellerSession.findFirst.mockResolvedValue(null);
    expect(await svc.currentSession(teller)).toBeNull();
  });
});

describe('BeneficiaryService', () => {
  it('a payee is active immediately only with recent strong auth; otherwise there is a cooling-off period', async () => {
    const rows = [row('acc-2', 0n, 'bob', { account_number: '100100000002' })];
    const prisma = buildPrisma(rows, {});
    prisma.beneficiary.findUnique.mockResolvedValue(null);
    const svc = new BeneficiaryService(prisma, policy);
    const activatesAt = async (actor: AuthenticatedUser) => {
      await svc.add(actor, '100100000002', 'Bob');
      return prisma.beneficiary.create.mock.calls.at(-1)[0].data.activatesAt.getTime();
    };
    expect(await activatesAt(alice)).toBeLessThanOrEqual(Date.now());
    for (const actor of [aliceNoMfa, aliceStale, aliceNewFactor]) {
      expect(await activatesAt(actor)).toBeGreaterThan(Date.now() + 59 * 60_000);
    }
  });

  it('a customer cannot add their own account or an unknown account', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice', { account_number: '100100000001' })], {});
    const svc = new BeneficiaryService(prisma, policy);
    await expect(svc.add(alice, '100100000001', 'Me')).rejects.toThrow();
    await expect(svc.add(alice, '999999999999', 'Nobody')).rejects.toThrow();
    expect(prisma.beneficiary.create).not.toHaveBeenCalled();
  });

  const BOB_NUMBER = '100100000002';
  const bobRows = () => [row('acc-2', 0n, 'bob', { account_number: BOB_NUMBER })];
  const ADD_ATTEMPTS = ['BENEFICIARY_ADDED', 'BENEFICIARY_READDED', 'BENEFICIARY_LOOKUP_FAILED'];

  it('ADD: the payee, its audit row and a beneficiary.added.v1 event commit together, one add at a time per customer', async () => {
    const prisma = buildPrisma(bobRows(), {});
    prisma.beneficiary.findUnique.mockResolvedValue(null);
    const db = transactional(prisma);
    const added = await new BeneficiaryService(prisma, policy).add(alice, BOB_NUMBER, 'Bob');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.secondConnection).toEqual([]);
    expect(db.audits()).toEqual(['BENEFICIARY_ADDED']);
    expect(db.committed('outboxEvent', 'create').map((e) => e.data)).toEqual([
      {
        aggregateType: 'BENEFICIARY',
        aggregateId: 'b-new',
        eventType: 'beneficiary.added.v1',
        status: 'PENDING',
        payload: {
          eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          eventType: 'beneficiary.added.v1',
          timestamp: expect.any(String),
          customerId: 'alice',
          beneficiaryId: 'b-new',
          accountNumberLast4: '0002',
          nickname: 'Bob',
          activatesAt: added.activatesAt.toISOString(),
        },
      },
    ]);
    // Serialised per customer before the daily count, so parallel adds can't race past the cap
    const lock = prisma.$queryRaw.mock.calls.findIndex(([s, key]: any) => s.join('').includes('pg_advisory_xact_lock') && key === 'beneficiaries:alice');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(prisma.$queryRaw.mock.invocationCallOrder[lock]).toBeLessThan(prisma.auditLog.count.mock.invocationCallOrder[0]);
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: { actorId: 'alice', action: { in: ADD_ATTEMPTS }, createdAt: { gte: expect.any(Date) } },
    });

    // Atomic: if the event can't be staged, nothing is added
    prisma.outboxEvent.create.mockRejectedValueOnce(new Error('db down'));
    await expect(new BeneficiaryService(prisma, policy).add(alice, BOB_NUMBER, 'Bob')).rejects.toThrow('db down');
    expect(db.committed('beneficiary', 'create')).toHaveLength(1);
  });

  it('RE-ADD: re-adding a removed payee restarts cooling-off and is audited, announced and counted like an add', async () => {
    const prisma = buildPrisma(bobRows(), {});
    prisma.beneficiary.findUnique.mockResolvedValue({ id: 'b1', revokedAt: new Date(), activatesAt: new Date(Date.now() - 5 * 86400_000) });
    const db = transactional(prisma);
    const readded: any = await new BeneficiaryService(prisma, policy).add(aliceNoMfa, BOB_NUMBER, 'Bob again');

    expect(prisma.beneficiary.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { revokedAt: null, nickname: 'Bob again', activatesAt: expect.any(Date) },
    });
    expect(readded.activatesAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(db.audits()).toEqual(['BENEFICIARY_READDED']);
    expect(db.committed('outboxEvent', 'create')[0].data.payload).toEqual(
      expect.objectContaining({ eventType: 'beneficiary.added.v1', beneficiaryId: 'b1', nickname: 'Bob again', accountNumberLast4: '0002' })
    );
  });

  it('PROBING: failed lookups are committed and count towards the daily add attempts', async () => {
    const prisma = buildPrisma([], {});
    const db = transactional(prisma);
    const svc = new BeneficiaryService(prisma, policy);
    prisma.auditLog.count.mockResolvedValue(3);
    expect((await svc.add(alice, '999999999999', 'Probe').catch((e) => e)).errorCode).toBe('INVALID_DESTINATION');
    expect(db.audits()).toEqual(['BENEFICIARY_LOOKUP_FAILED']);
    expect(db.committed('auditLog', 'create')[0].data).toEqual(expect.objectContaining({ actorId: 'alice', targetId: '999999999999' }));

    prisma.auditLog.count.mockResolvedValue(policy.maxNewBeneficiariesPerDay);
    expect((await svc.add(alice, '999999999999', 'Probe').catch((e) => e)).errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(prisma.ledgerAccount.findUnique).toHaveBeenCalledTimes(1); // capped before any lookup
  });
});

describe('LedgerService: reads and reconciliation', () => {
  const support: AuthenticatedUser = { id: 'support', email: 'support@bank.com', role: 'SUPPORT', mfa: true };

  it('CASH ACCOUNTS: drawers (and vault/suspense) are not readable through balance/history, except by BANK_ADMIN (audited)', async () => {
    const prisma = buildPrisma([], {});
    prisma.ledgerAccount.findUnique.mockResolvedValue({ id: 'drawer-teller', customerId: 'teller', kind: 'TELLER_CASH', balance: 5_000n, currency: 'INR' });
    prisma.ledgerEntry.findMany.mockResolvedValue([]);
    const svc = new LedgerService(prisma, policy);
    for (const actor of [teller, support, alice]) {
      await expect(svc.getAccountBalance('drawer-teller', actor)).rejects.toThrow(NotFoundError);
      await expect(svc.getTransactionHistory('drawer-teller', actor)).rejects.toThrow(NotFoundError);
    }
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    expect((await svc.getAccountBalance('drawer-teller', admin)).balanceInPaise).toBe('5000');
    await svc.getTransactionHistory('drawer-teller', admin);
    expect(prisma.auditLog.create.mock.calls.map(([{ data }]: any) => [data.actorId, data.action, data.targetId])).toEqual([
      ['admin', 'STAFF_VIEW_BALANCE', 'drawer-teller'],
      ['admin', 'STAFF_VIEW_HISTORY', 'drawer-teller'],
    ]);

    // Customer accounts are unchanged: the owner, or any staff member (audited)
    prisma.ledgerAccount.findUnique.mockResolvedValue({ id: 'acc-1', customerId: 'alice', kind: 'CUSTOMER', balance: 1n, currency: 'INR' });
    expect((await svc.getAccountBalance('acc-1', alice)).balanceInPaise).toBe('1');
    expect((await svc.getAccountBalance('acc-1', support)).balanceInPaise).toBe('1');
    await expect(svc.getAccountBalance('acc-1', mallory)).rejects.toThrow(NotFoundError);
  });

  it('RECONCILIATION: one snapshot with its own statement timeout, below the transaction timeout', async () => {
    const prisma = buildPrisma([], {});
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('unbalanced')) return Promise.resolve([{ unbalanced: 0n }]);
      if (sql.includes('AS customers')) return Promise.resolve([{ customers: 10n, assets: 10n, count: 3n }]);
      return Promise.resolve([]);
    });
    const result = await new LedgerService(prisma, policy).reconcileBalances();
    expect(result).toEqual({ checked: 3, mismatches: [], unbalancedTransactions: 0, zeroSumDelta: '0' });
    expect(prisma.$executeRaw.mock.calls[0][0].join('')).toBe("SET LOCAL statement_timeout = '110s'");
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual(expect.objectContaining({ isolationLevel: 'RepeatableRead', timeout: 120_000 }));
  });

  it('RECONCILIATION: a run that fails (e.g. a statement timeout) raises LEDGER_RECONCILIATION_ERROR', async () => {
    const prisma = buildPrisma([], {});
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      strings.join('?').includes('job_leases')
        ? Promise.resolve([{ holder: 'this-replica' }])
        : Promise.reject(new Error('canceling statement due to statement timeout'))
    );
    const error = jest.spyOn(logger, 'error');
    await expect(new LedgerService(prisma, policy).runScheduledReconciliation(1200)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ alert: 'LEDGER_RECONCILIATION_ERROR' }), expect.any(String));
    error.mockRestore();
  });
});

describe('LedgerService: account control state', () => {
  it('refuses to close an account with money, under the row lock', async () => {
    const prisma = buildPrisma([row('acc-1', 5n, 'alice')], {});
    await expect(new LedgerService(prisma, policy).closeAccount('acc-1', 2)).rejects.toThrow('balance must be zero');
    expect(prisma.ledgerAccount.update).not.toHaveBeenCalled();
  });
});

describe('Ledger policy configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses a default only when the variable is unset; an explicit 0 is honoured', () => {
    delete process.env.BENEFICIARY_COOLING_MINUTES;
    delete process.env.MFA_FACTOR_MIN_AGE_HOURS;
    delete process.env.MAX_NEW_BENEFICIARIES_PER_DAY;
    const defaults = defaultLedgerPolicy();
    expect(defaults.beneficiaryCoolingMinutes).toBe(60);
    expect(defaults.mfaFactorMinAgeHours).toBe(24);
    expect(defaults.maxNewBeneficiariesPerDay).toBe(10);
    process.env.BENEFICIARY_COOLING_MINUTES = '0';
    process.env.STEP_UP_THRESHOLD_PAISE = '20000000';
    expect(defaultLedgerPolicy()).toEqual(expect.objectContaining({ beneficiaryCoolingMinutes: 0, stepUpThreshold: 20_000_000n }));
  });

  it.each([
    ['BENEFICIARY_COOLING_MINUTES', ''], // Number('') is 0: would silently disable the cooling-off period
    ['MFA_FACTOR_MIN_AGE_HOURS', ' '],
    ['STEP_UP_MAX_AGE_SECONDS', 'abc'], // NaN: every step-up check would fail with a 500
    ['WITHDRAWAL_CODE_TTL_MINUTES', '-5'],
    ['CASH_APPROVAL_TTL_HOURS', '0'],
    ['MAX_NEW_BENEFICIARIES_PER_DAY', '2.5'],
    ['NEW_BENEFICIARY_LIMIT_PAISE', '1e6'],
    ['CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE', ''],
  ])('refuses to start with %s=%j', (name, value) => {
    process.env[name] = value;
    expect(() => defaultLedgerPolicy()).toThrow(name);
  });

  it('the service settings outside the policy are validated the same way', () => {
    delete process.env.RECONCILE_INTERVAL_MS;
    expect(envNumber('RECONCILE_INTERVAL_MS', 600_000, 1_000)).toBe(600_000);
    process.env.RECONCILE_INTERVAL_MS = 'ten minutes'; // NaN would make setInterval fire every millisecond
    expect(() => envNumber('RECONCILE_INTERVAL_MS', 600_000, 1_000)).toThrow('RECONCILE_INTERVAL_MS');
    process.env.IDEMPOTENCY_TTL_HOURS = '';
    expect(() => new IdempotencyService({} as any)).toThrow('IDEMPOTENCY_TTL_HOURS');
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
