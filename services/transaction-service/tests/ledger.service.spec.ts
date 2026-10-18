import { LedgerService, startOfIstDay, CashPolicy } from '../src/services/ledger.service';
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

const alice: AuthenticatedUser = { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER' };
const mallory: AuthenticatedUser = { id: 'mallory', email: 'mallory@bank.com', role: 'CUSTOMER' };
const teller: AuthenticatedUser = { id: 'teller', email: 'teller@bank.com', role: 'BANK_ADMIN', mfa: true };
const checker: AuthenticatedUser = { id: 'checker', email: 'checker@bank.com', role: 'BANK_ADMIN', mfa: true };

const policy: CashPolicy = {
  singleApprovalLimit: 20_000_000n,
  tellerDailyLimit: 100_000_000n,
  customerDailyOutflowLimit: 50_000_000n,
  approvalTtlHours: 24,
};

const row = (id: string, balance: bigint, customer: string, extra: Partial<any> = {}) => ({
  id,
  balance,
  is_active: true,
  closed_at: null,
  account_number: `10010000000${id.slice(-1)}`,
  customer_id: customer,
  currency: 'INR',
  daily_limit: 10_000_000n,
  ...extra,
});

function buildPrisma(rows: any[], owners: Record<string, string>) {
  const prisma: any = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
      if (sql.includes('cash_operations')) return Promise.resolve([{ id: 'op-1' }]);
      return Promise.resolve(rows);
    }),
    $executeRaw: jest.fn(),
    transaction: { create: jest.fn(({ data }: any) => ({ id: 'tx-1', createdAt: new Date(), ...data })) },
    ledgerEntry: {
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
      findMany: jest.fn(),
    },
    ledgerAccount: {
      update: jest.fn(),
      findUnique: jest.fn(({ where }: any) => {
        if (where.accountNumber) {
          const match = rows.find((r) => r.account_number === where.accountNumber);
          return Promise.resolve(match ? { id: match.id } : null);
        }
        const owner = owners[where.id];
        return Promise.resolve(owner ? { id: where.id, customerId: owner, isActive: true, closedAt: null } : null);
      }),
    },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    cashOperation: {
      create: jest.fn(({ data }: any) => ({ id: 'op-1', createdAt: new Date(), ...data })),
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
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 1n }, teller)).rejects.toThrow(NotFoundError);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it("ORACLE: checks the caller's own funds before revealing anything about the destination", async () => {
    const svc = new LedgerService(buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' }), policy);
    await expect(svc.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountNumber: '999999999999', amountInPaise: 100n }, alice)).rejects.toThrow(InsufficientFundsError);
  });

  it('ORACLE: missing, frozen and closed destinations all give the same INVALID_DESTINATION', async () => {
    for (const dest of [undefined, row('acc-2', 0n, 'bob', { is_active: false }), row('acc-2', 0n, 'bob', { closed_at: new Date() })]) {
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

describe('LedgerService: teller cash operations (maker-checker)', () => {
  it('SELF-DEALING: staff cannot deposit into (or withdraw from) their own account', async () => {
    const svc = new LedgerService(buildPrisma([row('acc-t', 0n, 'teller')], { 'acc-t': 'teller' }), policy);
    await expect(svc.requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-t', amountInPaise: 100n }, teller)).rejects.toThrow(ForbiddenError);
  });

  it('small deposits within budget execute immediately and are audited', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    const result = await new LedgerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 100_000n }, teller);
    expect(result.status).toBe('EXECUTED');
    expect(prisma.ledgerAccount.update).toHaveBeenCalledWith({ where: { id: 'acc-1' }, data: { balance: 100_000n } });
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('CASH_DEPOSIT_EXECUTED');
  });

  it('MINTING: a deposit above the single-approval limit only creates a pending request', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    const result = await new LedgerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 999_999_999n }, teller);
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(prisma.ledgerAccount.update).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('MINTING: many small deposits beyond the teller daily budget also need approval', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 99_000_000n } });
    const result = await new LedgerService(prisma, policy).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 5_000_000n }, teller);
    expect(result.status).toBe('PENDING_APPROVAL');
  });

  it('the requester cannot approve their own request; a different admin can', async () => {
    const pending = { id: 'op-1', type: 'DEPOSIT', status: 'PENDING_APPROVAL', accountId: 'acc-1', amount: 30_000_000n, requestedBy: 'teller', createdAt: new Date(), description: null };
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.findUniqueOrThrow.mockResolvedValue(pending);
    const svc = new LedgerService(prisma, policy);

    await expect(svc.approveCashOperation('op-1', teller)).rejects.toThrow(ForbiddenError);
    const result = await svc.approveCashOperation('op-1', checker);
    expect(result.status).toBe('EXECUTED');
    expect(prisma.cashOperation.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ status: 'EXECUTED', approvedBy: 'checker' }));
  });

  it('an already-decided request cannot be approved twice', async () => {
    const prisma = buildPrisma([row('acc-1', 0n, 'alice')], { 'acc-1': 'alice' });
    prisma.cashOperation.findUniqueOrThrow.mockResolvedValue({ id: 'op-1', status: 'EXECUTED', requestedBy: 'teller', accountId: 'acc-1', createdAt: new Date() });
    await expect(new LedgerService(prisma, policy).approveCashOperation('op-1', checker)).rejects.toThrow(ConflictError);
  });
});

describe('LedgerService: closing', () => {
  it('refuses to close an account with money, under the row lock', async () => {
    const prisma = buildPrisma([row('acc-1', 5n, 'alice')], {});
    await expect(new LedgerService(prisma, policy).closeAccount('acc-1')).rejects.toThrow('balance must be zero');
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
