import { logger, metricsRegistry } from '@banksphere/common';
import { LedgerService } from '../src/services/ledger.service';
import { ASSET_KINDS, assertWithinDailyLimits, defaultLedgerPolicy, isAssetKind } from '../src/services/ledger-core';
import { fakeLedgerDb } from './support/fake-ledger-db';
import { PaymentLedgerService, PAYMENT_CLEARING_ACCOUNT_NUMBER } from '../src/services/payment-ledger.service';

async function gaugeValues(): Promise<Record<string, number>> {
  const metric = await metricsRegistry.getSingleMetric('ledger_reconciliation_mismatches')?.get();
  return Object.fromEntries((metric?.values ?? []).map((v) => [String(v.labels.check), v.value]));
}

function reconcilingPrisma(answers: { mismatched: string[]; unbalanced: bigint; customers: bigint; assets: bigint }) {
  const prisma: any = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('net_credit')) return Promise.resolve(answers.mismatched.map((id) => ({ id })));
      if (sql.includes('unbalanced')) return Promise.resolve([{ unbalanced: answers.unbalanced }]);
      if (sql.includes('AS customers')) return Promise.resolve([{ customers: answers.customers, assets: answers.assets, count: 4n }]);
      return Promise.resolve([]);
    }),
  };
  prisma.$transaction = jest.fn((cb: any) => cb(prisma));
  return prisma;
}

describe('Reconciliation with PAYMENT_CLEARING', () => {
  it('PAYMENT_CLEARING is an asset (debit-normal), like the cash accounts; an unknown kind has no convention', () => {
    expect([...ASSET_KINDS]).toEqual(['TELLER_CASH', 'VAULT_CASH', 'CASH_SUSPENSE', 'PAYMENT_CLEARING']);
    expect(isAssetKind('PAYMENT_CLEARING')).toBe(true);
    expect(isAssetKind('CUSTOMER')).toBe(false);
    expect(() => isAssetKind('SOMETHING_NEW')).toThrow('no balance convention');
  });

  it('the balance and zero-sum checks treat PAYMENT_CLEARING as an asset; a balanced ledger reports 0 everywhere', async () => {
    // Customers are owed 10,000 that is receivable from the provider: balanced
    const prisma = reconcilingPrisma({ mismatched: [], unbalanced: 0n, customers: 10_000n, assets: 10_000n });
    const result = await new LedgerService(prisma).reconcileBalances();
    expect(result).toEqual({ checked: 4, mismatches: [], unbalancedTransactions: 0, zeroSumDelta: '0' });

    const [balanceCheck, , zeroSum] = prisma.$queryRaw.mock.calls;
    for (const [strings, ...values] of [balanceCheck, zeroSum]) {
      expect(strings.join('?')).toContain('kind::text IN (');
      expect(values[0].values).toEqual(['TELLER_CASH', 'VAULT_CASH', 'CASH_SUSPENSE', 'PAYMENT_CLEARING']);
    }
    // An account of an unknown kind can't match (NULL), so it is reported rather than silently skipped
    expect(balanceCheck[0].join('?')).toContain('IS DISTINCT FROM CASE');
    expect(await gaugeValues()).toEqual({ account_balance: 0, unbalanced_transaction: 0, zero_sum: 0 });
  });

  it('violations are alerted and exported as ledger_reconciliation_mismatches{check}', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const prisma = reconcilingPrisma({ mismatched: ['clearing-id'], unbalanced: 2n, customers: 10_000n, assets: 9_000n });
    const result = await new LedgerService(prisma).reconcileBalances();
    expect(result).toEqual({ checked: 4, mismatches: ['clearing-id'], unbalancedTransactions: 2, zeroSumDelta: '1000' });
    expect(await gaugeValues()).toEqual({ account_balance: 1, unbalanced_transaction: 2, zero_sum: 1 });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ alert: 'LEDGER_RECONCILIATION_FAILED' }), expect.any(String));
    error.mockRestore();
  });

  it('a series of top-ups, refunds and a reversal keeps every invariant (per-account entries, balanced transactions, zero sum)', async () => {
    const db = fakeLedgerDb();
    db.addAccount({ id: 'clearing', kind: 'PAYMENT_CLEARING', accountNumber: PAYMENT_CLEARING_ACCOUNT_NUMBER, customerId: 'BANK' });
    db.addAccount({ id: 'acc-a', customerId: 'cust-a' });
    db.addAccount({ id: 'acc-b', customerId: 'cust-b' });
    const payments = new PaymentLedgerService(db.client);
    const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await payments.credit({ topUpId: ids(1), accountId: 'acc-a', customerId: 'cust-a', amountPaise: 50_000n, providerPaymentId: 'pay_a' });
    await payments.credit({ topUpId: ids(2), accountId: 'acc-b', customerId: 'cust-b', amountPaise: 7_500n, providerPaymentId: 'pay_b' });
    await payments.refund({ refundId: ids(11), topUpId: ids(1), accountId: 'acc-a', customerId: 'cust-a', amountPaise: 20_000n });
    await payments.reverseRefund(ids(11));
    await payments.refund({ refundId: ids(12), topUpId: ids(2), accountId: 'acc-b', customerId: 'cust-b', amountPaise: 7_500n });
    expect(db.invariants()).toEqual({ mismatched: [], unbalanced: 0, zeroSumDelta: 0n });
    expect([db.account('acc-a').balance, db.account('acc-b').balance, db.account('clearing').balance]).toEqual([50_000n, 0n, 50_000n]);
  });
});

describe('Daily outflow limits and refunds', () => {
  it('refund debits (bank-initiated) do not use up the customer’s daily allowance', async () => {
    const tx: any = { ledgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }) } };
    const account = { id: 'acc-1', kind: 'CUSTOMER', balance: 0n, is_active: true, closed_at: null, account_number: '1', customer_id: 'alice', currency: 'INR', daily_limit: 10n } as const;
    await assertWithinDailyLimits(tx, account, 1n, defaultLedgerPolicy());
    for (const [{ where }] of tx.ledgerEntry.aggregate.mock.calls) {
      expect(where.transaction).toEqual({ type: { notIn: ['TOP_UP_REFUND'] } });
      expect(where.entryType).toBe('DEBIT');
    }
    expect(tx.ledgerEntry.aggregate).toHaveBeenCalledTimes(2);
  });
});
