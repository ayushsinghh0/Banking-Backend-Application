import { AuthenticatedUser, Cache, NotFoundError } from '@banksphere/common';
import { LedgerService } from '../src/services/ledger.service';
import { TellerService } from '../src/services/teller.service';
import { IdempotencyService } from '../src/services/idempotency.service';
import { PAYMENT_CLEARING_ACCOUNT_NUMBER, PaymentLedgerService } from '../src/services/payment-ledger.service';
import { LedgerCommits, notePosting } from '../src/services/ledger-commits';
import { LedgerReadCache } from '../src/services/ledger-cache';
import { LedgerPolicy, istBusinessDate, postDoubleEntry } from '../src/services/ledger-core';
import { TransactionController } from '../src/controllers/transaction.controller';
import { TransactionType } from '../src/types';
import { fakeLedgerDb } from './support/fake-ledger-db';
import { FakeRedis } from './support/fake-redis';

const ALICE = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';
const ALICE_ACC = '5d1c8a43-7b0e-4a55-8f4c-2e9a3c1d7b02';
const CLEARING = '00000000-0000-4000-8000-00000000c1ea';
const TOPUP = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';

const alice: AuthenticatedUser = { id: ALICE, email: 'alice@bank.com', role: 'CUSTOMER' };
const mallory: AuthenticatedUser = { id: 'mallory', email: 'mallory@bank.com', role: 'CUSTOMER' };
const support: AuthenticatedUser = { id: 'support', email: 'support@bank.com', role: 'SUPPORT', mfa: true };

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

/** A ledger with Alice's account, a real Cache over an in-memory Redis, and the services sharing one commit tracker */
function setup() {
  const db = fakeLedgerDb();
  db.addAccount({ id: CLEARING, kind: 'PAYMENT_CLEARING', accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER, customerId: 'BANK' });
  db.addAccount({ id: ALICE_ACC, customerId: ALICE, accountNumber: '200000000006' });
  const redis = new FakeRedis();
  const commits = new LedgerCommits(new LedgerReadCache(new Cache(redis as any, { namespace: 'ledger' })));
  const ledger = new LedgerService(db.client, policy, commits);
  const payments = new PaymentLedgerService(db.client, commits);
  const balanceReads = () => db.client.ledgerAccount.findUnique.mock.calls.filter(([args]: any) => args.select?.balance).length;
  const historyReads = () => db.client.ledgerEntry.findMany.mock.calls.length;
  const topUp = (amountPaise: bigint, topUpId = TOPUP) =>
    payments.credit({ topUpId, accountId: ALICE_ACC, customerId: ALICE, amountPaise, providerPaymentId: 'pay_N7xKzT1ab2CdEf' });
  return { db, redis, ledger, payments, balanceReads, historyReads, topUp };
}

describe('Ledger read cache (balance, history, account)', () => {
  it('MISS then HIT: the second read is served from the cache, under the documented keys', async () => {
    const { redis, ledger, balanceReads } = setup();
    expect((await ledger.getAccountBalance(ALICE_ACC, alice)).balanceInPaise).toBe('0');
    expect(balanceReads()).toBe(1);
    expect((await ledger.getAccountBalance(ALICE_ACC, alice)).balanceInPaise).toBe('0');
    expect(balanceReads()).toBe(1);
    expect([...redis.store.keys()].sort()).toEqual([`cache:ledger:acct:${ALICE_ACC}`, `cache:ledger:bal:${ALICE_ACC}:v0`]);
  });

  it('VERSION BUMP AFTER COMMIT: a committed posting makes the next read load the new balance and history', async () => {
    const { redis, ledger, balanceReads, historyReads, topUp } = setup();
    await ledger.getAccountBalance(ALICE_ACC, alice);
    expect(await ledger.getTransactionHistory(ALICE_ACC, alice)).toEqual([]);

    await topUp(10_000n);
    expect(redis.store.get(`cache:ledger:ver:${ALICE_ACC}`)).toBe('1');
    expect((await ledger.getAccountBalance(ALICE_ACC, alice)).balanceInPaise).toBe('10000');
    expect(balanceReads()).toBe(2);
    const history = await ledger.getTransactionHistory(ALICE_ACC, alice);
    expect(history).toEqual([expect.objectContaining({ type: 'ONLINE_TOP_UP', entryType: 'CREDIT', amountInPaise: '10000', balanceAfterInPaise: '10000' })]);
    expect(historyReads()).toBe(2);
    // ...and that page is now cached under the new version, Dates and all
    expect(await ledger.getTransactionHistory(ALICE_ACC, alice)).toEqual(history);
    expect(history[0].createdAt).toBeInstanceOf(Date);
    expect(historyReads()).toBe(2);
    expect(redis.store.has(`cache:ledger:hist:${ALICE_ACC}:v1:20:0`)).toBe(true);
  });

  it('NO BUMP ON ROLLBACK: a refused posting leaves the version (and the cached balance) alone', async () => {
    const { db, redis, ledger, payments, balanceReads } = setup();
    await ledger.getAccountBalance(ALICE_ACC, alice);
    db.account(ALICE_ACC).isActive = false;
    await expect(
      payments.credit({ topUpId: TOPUP, accountId: ALICE_ACC, customerId: ALICE, amountPaise: 1n, providerPaymentId: 'pay_1' })
    ).rejects.toMatchObject({ errorCode: 'ACCOUNT_NOT_CREDITABLE' });
    expect(redis.store.has(`cache:ledger:ver:${ALICE_ACC}`)).toBe(false);
    await ledger.getAccountBalance(ALICE_ACC, alice);
    expect(balanceReads()).toBe(1);
  });

  it('a version bump that would happen inside the transaction is impossible: postings are applied after commit only', async () => {
    const { db, redis, payments } = setup();
    const seen: Array<string | undefined> = [];
    const create = db.client.outboxEvent.create.getMockImplementation()!;
    db.client.outboxEvent.create.mockImplementation(async (args: any) => {
      seen.push(redis.store.get(`cache:ledger:ver:${ALICE_ACC}`)); // still inside the transaction
      return create(args);
    });
    await payments.credit({ topUpId: TOPUP, accountId: ALICE_ACC, customerId: ALICE, amountPaise: 5n, providerPaymentId: 'pay_1' });
    expect(seen).toEqual([undefined]);
    expect(redis.store.get(`cache:ledger:ver:${ALICE_ACC}`)).toBe('1');
  });

  it('AUTHORIZATION FIRST: a warm cache never answers another customer; staff reads are audited on every hit', async () => {
    const { db, ledger, balanceReads } = setup();
    await ledger.getAccountBalance(ALICE_ACC, alice);
    await expect(ledger.getAccountBalance(ALICE_ACC, mallory)).rejects.toThrow(NotFoundError);
    await expect(ledger.getTransactionHistory(ALICE_ACC, mallory)).rejects.toThrow(NotFoundError);

    await ledger.getAccountBalance(ALICE_ACC, support);
    await ledger.getAccountBalance(ALICE_ACC, support);
    expect(balanceReads()).toBe(1); // both staff reads were cache hits...
    expect(db.state.audit).toEqual([
      // ...and both were recorded
      { actorId: 'support', action: 'STAFF_VIEW_BALANCE', targetId: ALICE_ACC },
      { actorId: 'support', action: 'STAFF_VIEW_BALANCE', targetId: ALICE_ACC },
    ]);
  });

  it('only the first history pages are cached; deeper pages always come from the database', async () => {
    const { ledger, historyReads } = setup();
    await ledger.getTransactionHistory(ALICE_ACC, alice, 20, 80);
    await ledger.getTransactionHistory(ALICE_ACC, alice, 20, 80);
    expect(historyReads()).toBe(1);
    await ledger.getTransactionHistory(ALICE_ACC, alice, 20, 100);
    await ledger.getTransactionHistory(ALICE_ACC, alice, 20, 100);
    expect(historyReads()).toBe(3);
  });

  it('closing an account deletes its cached owner/kind and bumps its version (after commit)', async () => {
    const { redis, ledger } = setup();
    await ledger.getAccountBalance(ALICE_ACC, alice);
    expect(redis.store.has(`cache:ledger:acct:${ALICE_ACC}`)).toBe(true);
    await ledger.closeAccount(ALICE_ACC, 2);
    expect(redis.store.has(`cache:ledger:acct:${ALICE_ACC}`)).toBe(false);
    expect(redis.store.get(`cache:ledger:ver:${ALICE_ACC}`)).toBe('1');
  });

  it('FAIL OPEN: with the cache Redis down, reads come from the database, still authorized', async () => {
    const { redis, ledger, topUp } = setup();
    await topUp(700n);
    redis.failing = true;
    expect((await ledger.getAccountBalance(ALICE_ACC, alice)).balanceInPaise).toBe('700');
    await expect(ledger.getAccountBalance(ALICE_ACC, mallory)).rejects.toThrow(NotFoundError);
  });
});

describe('Every posting path goes through the commit scope', () => {
  it('a posting outside LedgerCommits.run is refused before anything is written', async () => {
    const tx: any = { ledgerEntry: { create: jest.fn() }, ledgerAccount: { update: jest.fn() } };
    const account = { id: 'a', kind: 'CUSTOMER', balance: 0n, is_active: true, closed_at: null, account_number: '1', customer_id: 'c', currency: 'INR', daily_limit: 1n } as const;
    await expect(
      postDoubleEntry(tx, { transactionId: 't', type: TransactionType.TRANSFER, debit: { ...account, balance: 5n }, credit: { ...account, id: 'b' }, amount: 1n })
    ).rejects.toThrow('outside LedgerCommits.run');
    expect(() => notePosting('TRANSFER', ['a'])).toThrow('outside LedgerCommits.run');
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  /** Transfers and teller cash on a mocked client (the shape the ledger.service spec uses) */
  function mockedLedger() {
    const rows = [
      { id: 'acc-1', kind: 'CUSTOMER', balance: 50_000n, is_active: true, closed_at: null, account_number: '100100000001', customer_id: 'alice', currency: 'INR', daily_limit: 10_000_000n },
      { id: 'acc-2', kind: 'CUSTOMER', balance: 0n, is_active: true, closed_at: null, account_number: '100100000002', customer_id: 'bob', currency: 'INR', daily_limit: 10_000_000n },
      { id: 'drawer', kind: 'TELLER_CASH', balance: 0n, is_active: true, closed_at: null, account_number: 'DRAWER-teller', customer_id: 'teller', currency: 'INR', daily_limit: 1n },
    ];
    const prisma: any = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => Promise.resolve(strings.join('?').includes('FOR UPDATE') ? rows : [])),
      $executeRaw: jest.fn(),
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      transaction: { create: jest.fn(({ data }: any) => ({ id: 'tx-1', createdAt: new Date(), ...data })), aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }) },
      ledgerEntry: { create: jest.fn(), aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }) },
      ledgerAccount: {
        update: jest.fn(),
        findUnique: jest.fn(({ where }: any) => Promise.resolve({ id: where.id, customerId: where.id === 'acc-1' ? 'alice' : 'bob', kind: 'CUSTOMER', isActive: true, closedAt: null })),
        findFirst: jest.fn().mockResolvedValue({ id: 'drawer', balance: 0n }),
      },
      beneficiary: { findUnique: jest.fn().mockResolvedValue({ id: 'b1', revokedAt: null, activatesAt: new Date(Date.now() - 2 * 86400_000) }) },
      tellerSession: { findFirst: jest.fn().mockResolvedValue({ id: 's', tellerId: 'teller', status: 'OPEN', businessDate: istBusinessDate() }) },
      cashOperation: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
        create: jest.fn(({ data }: any) => ({ createdAt: new Date(), ...data })),
        update: jest.fn(),
      },
      outboxEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction = jest.fn((cb: any) => cb(prisma));
    const readCache = new LedgerReadCache();
    const changed = jest.spyOn(readCache, 'accountsChanged');
    return { prisma, commits: new LedgerCommits(readCache), changed };
  }

  const aliceUser: AuthenticatedUser = { id: 'alice', email: 'a@bank.com', role: 'CUSTOMER' };
  const tellerUser: AuthenticatedUser = { id: 'teller', email: 't@bank.com', role: 'TELLER', mfa: true };

  it('transfers (direct and through the idempotent HTTP path) bump both accounts after commit, and nothing on rollback', async () => {
    const { prisma, commits, changed } = mockedLedger();
    const ledger = new LedgerService(prisma, policy, commits);
    await ledger.executeTransfer({ sourceAccountId: 'acc-1', destinationAccountId: 'acc-2', amountInPaise: 100n }, aliceUser);
    expect(changed).toHaveBeenLastCalledWith(['acc-1', 'acc-2']);

    const controller = new TransactionController(ledger, {} as any, {} as any, new IdempotencyService(prisma, 24, commits));
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const req: any = {
      user: aliceUser,
      body: { sourceAccountId: '11111111-1111-4111-8111-111111111111', destinationAccountId: '22222222-2222-4222-8222-222222222222', amountInPaise: '100' },
      header: (name: string) => (name === 'Idempotency-Key' ? 'transfer-key-0001' : undefined),
    };
    changed.mockClear();
    prisma.ledgerAccount.findUnique.mockResolvedValue({ customerId: 'alice', kind: 'CUSTOMER' });
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('FOR UPDATE')
          ? [
              { ...{ kind: 'CUSTOMER', balance: 50_000n, is_active: true, closed_at: null, account_number: '1', customer_id: 'alice', currency: 'INR', daily_limit: 10_000_000n }, id: req.body.sourceAccountId },
              { ...{ kind: 'CUSTOMER', balance: 0n, is_active: true, closed_at: null, account_number: '2', customer_id: 'bob', currency: 'INR', daily_limit: 10_000_000n }, id: req.body.destinationAccountId },
            ]
          : []
      )
    );
    await new Promise<void>((resolve, reject) => {
      res.json.mockImplementation(() => resolve());
      controller.transfer(req, res, reject);
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(changed).toHaveBeenCalledWith([req.body.sourceAccountId, req.body.destinationAccountId]);

    // The same transfer failing at the last write (outbox) rolls back: no bump
    changed.mockClear();
    prisma.outboxEvent.create.mockRejectedValueOnce(new Error('db down'));
    await expect(ledger.executeTransfer({ sourceAccountId: req.body.sourceAccountId, destinationAccountId: req.body.destinationAccountId, amountInPaise: 100n }, aliceUser)).rejects.toThrow('db down');
    expect(changed).not.toHaveBeenCalled();
  });

  it('teller cash bumps the customer account and the drawer after commit', async () => {
    const { prisma, commits, changed } = mockedLedger();
    const result = await new TellerService(prisma, policy, commits).requestCashOperation({ type: 'DEPOSIT', accountId: 'acc-1', amountInPaise: 1_000n }, tellerUser);
    expect(result.status).toBe('EXECUTED');
    expect(changed).toHaveBeenCalledWith(['drawer', 'acc-1']);
  });
});
