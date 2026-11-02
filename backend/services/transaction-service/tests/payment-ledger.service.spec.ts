import { Cache, HttpError, metricsRegistry } from '@banksphere/common';
import {
  PAYMENT_CLEARING_ACCOUNT_NUMBER,
  PAYMENT_SERVICE_ACTOR,
  PaymentLedgerService,
  TopUpCreditDTO,
  TopUpRefundDTO,
} from '../src/services/payment-ledger.service';
import { LedgerCommits } from '../src/services/ledger-commits';
import { LedgerReadCache } from '../src/services/ledger-cache';
import { MAX_BALANCE } from '../src/services/ledger-core';
import { fakeLedgerDb } from './support/fake-ledger-db';
import { FakeRedis } from './support/fake-redis';

const ALICE = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';
const BOB = '7c1d9e40-3b2a-4f6e-8d1c-5a4b3c2d1e0f';
const ALICE_ACC = '5d1c8a43-7b0e-4a55-8f4c-2e9a3c1d7b02';
const BOB_ACC = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CLEARING = '00000000-0000-4000-8000-00000000c1ea';
const TOPUP = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const TOPUP_2 = '4a3b2c1d-0e9f-4876-9543-21fedcba0987';
const REFUND = '6e5d4c3b-2a19-4087-b654-3210fedcba98';
const REFUND_2 = '7f6e5d4c-3b2a-4198-a765-43210fedcba9';

function setup() {
  const db = fakeLedgerDb();
  db.addAccount({ id: CLEARING, kind: 'PAYMENT_CLEARING', accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER, customerId: 'BANK', dailyLimit: MAX_BALANCE });
  db.addAccount({ id: ALICE_ACC, customerId: ALICE, accountNumber: '200000000006' });
  db.addAccount({ id: BOB_ACC, customerId: BOB, accountNumber: '200000000014' });
  const redis = new FakeRedis();
  const commits = new LedgerCommits(new LedgerReadCache(new Cache(redis as any, { namespace: 'ledger' })));
  const service = new PaymentLedgerService(db.client, commits);
  return { db, redis, service };
}

const credit = (over: Partial<TopUpCreditDTO> = {}): TopUpCreditDTO => ({
  topUpId: TOPUP,
  accountId: ALICE_ACC,
  customerId: ALICE,
  amountPaise: 10_000n,
  providerPaymentId: 'pay_N7xKzT1ab2CdEf',
  ...over,
});

const refund = (over: Partial<TopUpRefundDTO> = {}): TopUpRefundDTO => ({
  refundId: REFUND,
  topUpId: TOPUP,
  accountId: ALICE_ACC,
  customerId: ALICE,
  amountPaise: 4_000n,
  ...over,
});

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'OK',
    (err) => (err instanceof HttpError || err?.errorCode ? `${err.statusCode} ${err.errorCode}` : String(err))
  );

async function postings(type: string): Promise<number> {
  const metric = (await metricsRegistry.getSingleMetric('ledger_postings_total')?.get())?.values ?? [];
  return metric.find((v) => v.labels.type === type)?.value ?? 0;
}

describe('PaymentLedgerService: top-up credits', () => {
  it('posts debit PAYMENT_CLEARING, credit customer, stages transaction.completed.v1 keyed by the account', async () => {
    const { db, service } = setup();
    const result = await service.credit(credit());

    expect(result).toEqual({ transactionId: expect.any(String), referenceId: `TOPUP-${TOPUP}`, replayed: false });
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(db.account(CLEARING).balance).toBe(10_000n); // asset: receivable from the provider
    expect(db.state.entries).toEqual([
      expect.objectContaining({ accountId: CLEARING, entryType: 'DEBIT', amount: 10_000n, balanceAfter: 10_000n }),
      expect.objectContaining({ accountId: ALICE_ACC, entryType: 'CREDIT', amount: 10_000n, balanceAfter: 10_000n }),
    ]);
    expect(db.state.transactions).toEqual([
      expect.objectContaining({
        referenceId: `TOPUP-${TOPUP}`,
        type: 'ONLINE_TOP_UP',
        status: 'COMPLETED',
        amount: 10_000n,
        destinationAccountId: ALICE_ACC,
        sourceAccountId: null,
        initiatedBy: ALICE,
        topUpId: TOPUP,
        externalReference: 'pay_N7xKzT1ab2CdEf',
      }),
    ]);
    expect(db.state.outbox).toEqual([
      {
        aggregateId: ALICE_ACC,
        eventType: 'transaction.completed.v1',
        payload: expect.objectContaining({
          eventType: 'transaction.completed.v1',
          transactionId: result.transactionId,
          referenceId: `TOPUP-${TOPUP}`,
          type: 'ONLINE_TOP_UP',
          amountInPaise: '10000',
          currency: 'INR',
          destinationAccountId: ALICE_ACC,
          destinationCustomerId: ALICE,
          initiatedBy: ALICE,
          topUpId: TOPUP,
        }),
      },
    ]);
    // The clearing account is never an event side (fraud and real-time only see the customer's account)
    expect(db.state.outbox[0].payload).not.toHaveProperty('sourceAccountId');
    expect(db.invariants()).toEqual({ mismatched: [], unbalanced: 0, zeroSumDelta: 0n });
  });

  it('IDEMPOTENT: a replay returns the original posting (replayed: true) and moves nothing', async () => {
    const { db, service } = setup();
    const first = await service.credit(credit());
    const again = await service.credit(credit());
    expect(again).toEqual({ ...first, replayed: true });
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(db.state.transactions).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
  });

  it.each([
    ['a different amount', { amountPaise: 10_001n }],
    ['a different account', { accountId: BOB_ACC, customerId: BOB }],
    ['a different customer', { customerId: BOB }],
    ['a different provider payment', { providerPaymentId: 'pay_Other000000000' }],
  ])('CONFLICT: a replay with %s is a 409 and moves nothing', async (_label, change) => {
    const { db, service } = setup();
    await service.credit(credit());
    expect(await codeOf(service.credit(credit(change)))).toBe('409 IDEMPOTENCY_CONFLICT');
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(db.account(BOB_ACC).balance).toBe(0n);
    expect(db.state.transactions).toHaveLength(1);
  });

  it('CONCURRENT duplicates are serialised by the row locks: exactly one posting, the other is a replay', async () => {
    const { db, service } = setup();
    const results = await Promise.all([service.credit(credit()), service.credit(credit()), service.credit(credit())]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(db.state.transactions).toHaveLength(1);
  });

  it('a duplicate that loses the unique reference (P2002) replays the winner, or 409s if the winner differs', async () => {
    const { db, service } = setup();
    const winner = {
      id: 'txn-winner',
      referenceId: `TOPUP-${TOPUP}`,
      type: 'ONLINE_TOP_UP',
      status: 'COMPLETED',
      amount: 10_000n,
      currency: 'INR',
      sourceAccountId: null,
      destinationAccountId: ALICE_ACC,
      description: null,
      initiatedBy: ALICE,
      topUpId: TOPUP,
      externalReference: 'pay_N7xKzT1ab2CdEf',
      createdAt: new Date(),
    };
    db.client.$transaction.mockImplementationOnce(async () => {
      db.state.transactions.push(winner); // committed by a concurrent request in the meantime
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    expect(await service.credit(credit())).toEqual({ transactionId: 'txn-winner', referenceId: `TOPUP-${TOPUP}`, replayed: true });

    const other = setup();
    other.db.client.$transaction.mockImplementationOnce(async () => {
      other.db.state.transactions.push({ ...winner, amount: 1n });
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    expect(await codeOf(other.service.credit(credit()))).toBe('409 IDEMPOTENCY_CONFLICT');
  });

  it('NOT CREDITABLE: frozen, closed, another customer’s or non-INR accounts are refused with 409; nothing is posted', async () => {
    const cases: Array<[string, (db: ReturnType<typeof fakeLedgerDb>) => void, Partial<TopUpCreditDTO>]> = [
      ['frozen', (db) => (db.account(ALICE_ACC).isActive = false), {}],
      ['closed', (db) => Object.assign(db.account(ALICE_ACC), { isActive: false, closedAt: new Date() }), {}],
      ['owner mismatch', () => undefined, { customerId: BOB }],
      ['currency', (db) => (db.account(ALICE_ACC).currency = 'USD'), {}],
    ];
    for (const [label, arrange, change] of cases) {
      const { db, service } = setup();
      arrange(db);
      expect([label, await codeOf(service.credit(credit(change)))]).toEqual([label, '409 ACCOUNT_NOT_CREDITABLE']);
      expect(db.state.transactions).toHaveLength(0);
      expect(db.state.outbox).toHaveLength(0);
      expect(db.account(CLEARING).balance).toBe(0n);
    }
  });

  it('only CUSTOMER accounts can be credited: a missing account or a system account is a 404', async () => {
    const { db, service } = setup();
    expect(await codeOf(service.credit(credit({ accountId: '11111111-1111-4111-8111-111111111111' })))).toBe('404 NOT_FOUND');
    expect(await codeOf(service.credit(credit({ accountId: CLEARING, customerId: 'BANK' })))).toBe('404 NOT_FOUND');
    expect(db.state.transactions).toHaveLength(0);
  });

  it('BALANCE CEILING: a credit that would exceed the maximum balance is refused and rolled back', async () => {
    const { db, service } = setup();
    db.account(ALICE_ACC).balance = MAX_BALANCE - 5n;
    expect(await codeOf(service.credit(credit({ amountPaise: 6n })))).toBe('422 BALANCE_LIMIT');
    expect(db.account(ALICE_ACC).balance).toBe(MAX_BALANCE - 5n);
    expect(db.state.transactions).toHaveLength(0);
    expect(await codeOf(service.credit(credit({ amountPaise: 5n })))).toBe('OK'); // exactly at the ceiling
  });
});

describe('PaymentLedgerService: refunds and their reversal', () => {
  async function credited(amountPaise = 10_000n) {
    const ctx = setup();
    await ctx.service.credit(credit({ amountPaise }));
    return ctx;
  }

  it('posts debit customer, credit PAYMENT_CLEARING, on behalf of payment-service, with the event on the account', async () => {
    const { db, service } = await credited();
    const result = await service.refund(refund());
    expect(result).toEqual({ transactionId: expect.any(String), referenceId: `TOPUP-REFUND-${REFUND}`, replayed: false });
    expect(db.account(ALICE_ACC).balance).toBe(6_000n);
    expect(db.account(CLEARING).balance).toBe(6_000n);
    expect(db.state.entries.slice(-2)).toEqual([
      expect.objectContaining({ accountId: ALICE_ACC, entryType: 'DEBIT', amount: 4_000n, balanceAfter: 6_000n }),
      expect.objectContaining({ accountId: CLEARING, entryType: 'CREDIT', amount: 4_000n, balanceAfter: 6_000n }),
    ]);
    expect(db.state.transactions.at(-1)).toEqual(
      expect.objectContaining({ type: 'TOP_UP_REFUND', sourceAccountId: ALICE_ACC, destinationAccountId: null, initiatedBy: PAYMENT_SERVICE_ACTOR, topUpId: TOPUP })
    );
    expect(db.state.outbox.at(-1)).toEqual({
      aggregateId: ALICE_ACC,
      eventType: 'transaction.completed.v1',
      payload: expect.objectContaining({
        type: 'TOP_UP_REFUND',
        amountInPaise: '4000',
        sourceAccountId: ALICE_ACC,
        sourceCustomerId: ALICE,
        initiatedBy: PAYMENT_SERVICE_ACTOR,
        topUpId: TOPUP,
        refundId: REFUND,
      }),
    });
    expect(db.invariants()).toEqual({ mismatched: [], unbalanced: 0, zeroSumDelta: 0n });
  });

  it('IDEMPOTENT on the refund id; a replay with different details is a 409', async () => {
    const { db, service } = await credited();
    const first = await service.refund(refund());
    expect(await service.refund(refund())).toEqual({ ...first, replayed: true });
    expect(db.account(ALICE_ACC).balance).toBe(6_000n);
    expect(await codeOf(service.refund(refund({ amountPaise: 4_001n })))).toBe('409 IDEMPOTENCY_CONFLICT');
    expect(await codeOf(service.refund(refund({ topUpId: TOPUP_2 })))).toBe('409 IDEMPOTENCY_CONFLICT');
    expect(await codeOf(service.refund(refund({ customerId: BOB })))).toBe('409 IDEMPOTENCY_CONFLICT');
    expect(db.state.transactions).toHaveLength(2);
  });

  it('NEVER OVERDRAWS: 409 INSUFFICIENT_FUNDS when the customer has spent the money; nothing moves', async () => {
    const { db, service } = await credited();
    db.account(ALICE_ACC).balance = 3_999n; // spent since the top-up
    expect(await codeOf(service.refund(refund()))).toBe('409 INSUFFICIENT_FUNDS');
    expect(db.account(ALICE_ACC).balance).toBe(3_999n);
    expect(db.account(CLEARING).balance).toBe(10_000n);
    expect(db.state.transactions).toHaveLength(1);
    db.account(ALICE_ACC).balance = 4_000n;
    expect(await codeOf(service.refund(refund()))).toBe('OK'); // exactly the balance
    expect(db.account(ALICE_ACC).balance).toBe(0n);
  });

  it('BANK-INITIATED: no daily outflow limit applies (the refund exceeds the account’s daily limit)', async () => {
    const { db, service } = await credited(10_000n);
    db.account(ALICE_ACC).dailyLimit = 1_000n;
    expect(await codeOf(service.refund(refund({ amountPaise: 10_000n })))).toBe('OK');
    expect(db.account(ALICE_ACC).balance).toBe(0n);
  });

  it('only what the top-up credited, to that account, can be taken back (net of reversed refunds)', async () => {
    const { db, service } = await credited(10_000n);
    expect(await codeOf(service.refund(refund({ amountPaise: 10_001n })))).toBe('409 REFUND_EXCEEDS_TOP_UP');
    expect(await codeOf(service.refund(refund({ amountPaise: 6_000n })))).toBe('OK');
    expect(await codeOf(service.refund(refund({ refundId: REFUND_2, amountPaise: 4_001n })))).toBe('409 REFUND_EXCEEDS_TOP_UP');
    expect(await codeOf(service.refund(refund({ refundId: REFUND_2, amountPaise: 4_000n })))).toBe('OK');
    expect(db.account(ALICE_ACC).balance).toBe(0n);

    // A reversed refund frees its amount again (a new refund needs a new refund id)
    await service.reverseRefund(REFUND_2);
    const REFUND_3 = '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
    expect(await codeOf(service.refund(refund({ refundId: REFUND_3, amountPaise: 4_001n })))).toBe('409 REFUND_EXCEEDS_TOP_UP');
    expect(await codeOf(service.refund(refund({ refundId: REFUND_3, amountPaise: 4_000n })))).toBe('OK');
    expect(db.invariants()).toEqual({ mismatched: [], unbalanced: 0, zeroSumDelta: 0n });
  });

  it('a top-up that was never credited (or was credited elsewhere) has nothing to refund', async () => {
    const { db, service } = await credited();
    expect(await codeOf(service.refund(refund({ topUpId: TOPUP_2 })))).toBe('409 TOP_UP_NOT_CREDITED');
    db.account(BOB_ACC).balance = 50_000n;
    expect(await codeOf(service.refund(refund({ accountId: BOB_ACC, customerId: BOB })))).toBe('409 TOP_UP_NOT_CREDITED');
    expect(db.account(BOB_ACC).balance).toBe(50_000n);
  });

  it('works on a frozen account (money returns to its source); refused on a closed account or another customer’s', async () => {
    const { db, service } = await credited();
    db.account(ALICE_ACC).isActive = false;
    expect(await codeOf(service.refund(refund()))).toBe('OK');

    const closed = await credited();
    Object.assign(closed.db.account(ALICE_ACC), { isActive: false, closedAt: new Date() });
    expect(await codeOf(closed.service.refund(refund()))).toBe('409 ACCOUNT_CLOSED');
    expect(await codeOf(closed.service.refund(refund({ customerId: BOB })))).toBe('409 ACCOUNT_MISMATCH');
    expect(closed.db.state.transactions).toHaveLength(1);
    expect(await codeOf(closed.service.refund(refund({ accountId: '11111111-1111-4111-8111-111111111111' })))).toBe('404 NOT_FOUND');
  });

  it('REVERSAL (compensation): gives the refunded amount back, idempotently; an unknown refund is a 404', async () => {
    const { db, service } = await credited();
    await service.refund(refund());
    db.account(ALICE_ACC).isActive = false; // frozen meanwhile: the compensation still lands

    const reversed = await service.reverseRefund(REFUND);
    expect(reversed).toEqual({ transactionId: expect.any(String), referenceId: `TOPUP-REFUND-REV-${REFUND}`, replayed: false });
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(db.account(CLEARING).balance).toBe(10_000n);
    expect(db.state.transactions.at(-1)).toEqual(
      expect.objectContaining({ type: 'ONLINE_TOP_UP', destinationAccountId: ALICE_ACC, amount: 4_000n, topUpId: TOPUP, initiatedBy: PAYMENT_SERVICE_ACTOR })
    );
    expect(db.state.outbox.at(-1)?.payload).toEqual(
      expect.objectContaining({ type: 'ONLINE_TOP_UP', destinationAccountId: ALICE_ACC, destinationCustomerId: ALICE, refundId: REFUND })
    );
    expect(await service.reverseRefund(REFUND)).toEqual({ ...reversed, replayed: true });
    expect(db.account(ALICE_ACC).balance).toBe(10_000n);
    expect(await codeOf(service.reverseRefund(REFUND_2))).toBe('404 REFUND_NOT_FOUND');
    expect(db.invariants()).toEqual({ mismatched: [], unbalanced: 0, zeroSumDelta: 0n });
  });

  it('REVERSAL on a closed account is refused (a person resolves it)', async () => {
    const { db, service } = await credited();
    await service.refund(refund({ amountPaise: 10_000n }));
    Object.assign(db.account(ALICE_ACC), { isActive: false, closedAt: new Date() });
    expect(await codeOf(service.reverseRefund(REFUND))).toBe('409 ACCOUNT_CLOSED');
    expect(db.account(CLEARING).balance).toBe(0n);
  });
});

describe('PaymentLedgerService: after-commit effects', () => {
  it('bumps the cache version of both accounts and counts the posting only after commit, never for a refusal', async () => {
    const { redis, service } = setup();
    const version = (id: string) => Number(redis.store.get(`cache:ledger:ver:${id}`) ?? 0);
    const before = await postings('ONLINE_TOP_UP');

    await service.credit(credit({ customerId: BOB })).catch(() => undefined); // refused: rolled back
    expect([version(ALICE_ACC), version(CLEARING)]).toEqual([0, 0]);
    expect(await postings('ONLINE_TOP_UP')).toBe(before);

    await service.credit(credit());
    expect([version(ALICE_ACC), version(CLEARING)]).toEqual([1, 1]);
    expect(await postings('ONLINE_TOP_UP')).toBe(before + 1);

    await service.credit(credit()); // replay: nothing committed, nothing bumped
    expect([version(ALICE_ACC), version(CLEARING)]).toEqual([1, 1]);
    expect(await postings('ONLINE_TOP_UP')).toBe(before + 1);
  });
});

describe('PaymentLedgerService: accounts', () => {
  it('GET account: owner, last 4 digits and state of CUSTOMER accounts only', async () => {
    const { db, service } = setup();
    db.account(ALICE_ACC).isActive = false;
    expect(await service.getAccount(ALICE_ACC)).toEqual({ accountId: ALICE_ACC, customerId: ALICE, accountNumberLast4: '0006', isActive: false, closed: false });
    expect(await codeOf(service.getAccount(CLEARING))).toBe('404 NOT_FOUND');
    expect(await codeOf(service.getAccount('11111111-1111-4111-8111-111111111111'))).toBe('404 NOT_FOUND');
  });

  it('PAYMENT_CLEARING is provisioned idempotently, and never confused with another kind', async () => {
    const db = fakeLedgerDb();
    const service = new PaymentLedgerService(db.client);
    const created = await service.ensureClearingAccount();
    expect(await service.ensureClearingAccount()).toEqual(expect.objectContaining({ id: created.id }));
    expect([...db.state.accounts.values()].filter((a) => a.kind === 'PAYMENT_CLEARING')).toEqual([
      expect.objectContaining({ accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER, customerId: 'BANK', balance: 0n, isActive: true }),
    ]);

    const wrong = fakeLedgerDb();
    wrong.addAccount({ id: 'x', kind: 'VAULT_CASH', accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER });
    await expect(new PaymentLedgerService(wrong.client).ensureClearingAccount()).rejects.toThrow('kind VAULT_CASH');
  });

  it('a fresh ledger without the migration still posts (the clearing account is created on first use)', async () => {
    const db = fakeLedgerDb();
    db.addAccount({ id: ALICE_ACC, customerId: ALICE });
    const service = new PaymentLedgerService(db.client);
    await service.credit(credit());
    const clearing = [...db.state.accounts.values()].find((a) => a.kind === 'PAYMENT_CLEARING');
    expect(clearing?.balance).toBe(10_000n);
  });
});
