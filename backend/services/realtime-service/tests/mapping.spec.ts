/**
 * The event -> channel mapping table (design section 8): who hears about what, and with exactly which fields.
 */
import { mapEvent } from '../src/events/mapping';
import { Delivery } from '../src/events/types';

const NOW = new Date('2026-10-28T10:00:00.000Z');
const ids = {
  event: '0b6c9c55-4d2e-4f8e-9c3a-111111111111',
  tx: '0b6c9c55-4d2e-4f8e-9c3a-222222222222',
  srcAcct: 'acc-src-1',
  dstAcct: 'acc-dst-1',
  alice: 'cust-alice',
  bob: 'cust-bob',
};

const envelope = (extra: Record<string, unknown>) => ({ eventId: ids.event, timestamp: '2026-10-28T09:59:58.000Z', ...extra });

function deliveries(topic: string, payload: unknown): Delivery[] {
  const result = mapEvent(topic, payload, NOW);
  if (!result.ok) throw new Error(`expected a mapping, got: ${result.reason}`);
  return result.deliveries;
}

describe('event -> channel mapping', () => {
  it('transaction.completed.v1: BOTH parties of a transfer get transaction.posted for their own side, nothing more', () => {
    const out = deliveries(
      'transaction.completed.v1',
      envelope({
        eventType: 'transaction.completed.v1',
        transactionId: ids.tx,
        referenceId: 'TXN-123',
        type: 'TRANSFER',
        amountInPaise: '250000',
        currency: 'INR',
        sourceAccountId: ids.srcAcct,
        destinationAccountId: ids.dstAcct,
        sourceCustomerId: ids.alice,
        destinationCustomerId: ids.bob,
        initiatedBy: ids.alice,
      })
    );
    expect(out).toEqual([
      {
        kind: 'user',
        userId: ids.alice,
        dedupeKey: `${ids.event}:debit`,
        event: {
          type: 'transaction.posted',
          at: '2026-10-28T09:59:58.000Z',
          data: { transactionId: ids.tx, type: 'TRANSFER', amountInPaise: '250000', accountId: ids.srcAcct, direction: 'DEBIT' },
        },
      },
      {
        kind: 'user',
        userId: ids.bob,
        dedupeKey: `${ids.event}:credit`,
        event: {
          type: 'transaction.posted',
          at: '2026-10-28T09:59:58.000Z',
          data: { transactionId: ids.tx, type: 'TRANSFER', amountInPaise: '250000', accountId: ids.dstAcct, direction: 'CREDIT' },
        },
      },
    ]);
    // No reference ids, initiator or currency leak into the hint
    expect(JSON.stringify(out)).not.toMatch(/TXN-123|initiatedBy|currency/);
  });

  it('a transfer between a customer\'s own accounts reaches them twice (debit and credit), with distinct dedupe keys', () => {
    const out = deliveries(
      'transaction.completed.v1',
      envelope({ transactionId: ids.tx, type: 'TRANSFER', amountInPaise: '100', sourceAccountId: 'a1', destinationAccountId: 'a2', sourceCustomerId: ids.alice, destinationCustomerId: ids.alice })
    );
    expect(out.map((d) => [d.kind === 'user' && d.userId, d.kind === 'user' && d.dedupeKey, d.event.data.direction])).toEqual([
      [ids.alice, `${ids.event}:debit`, 'DEBIT'],
      [ids.alice, `${ids.event}:credit`, 'CREDIT'],
    ]);
  });

  it.each([
    ['teller deposit (drawer side has no customer)', { type: 'DEPOSIT', destinationAccountId: ids.dstAcct, destinationCustomerId: ids.bob }, [[ids.bob, 'CREDIT']]],
    ['teller withdrawal', { type: 'WITHDRAWAL', sourceAccountId: ids.srcAcct, sourceCustomerId: ids.alice }, [[ids.alice, 'DEBIT']]],
    ['top-up (payment clearing has no customer)', { type: 'ONLINE_TOP_UP', sourceAccountId: 'clearing-1', destinationAccountId: ids.dstAcct, destinationCustomerId: ids.bob }, [[ids.bob, 'CREDIT']]],
    ['top-up refund', { type: 'TOP_UP_REFUND', sourceAccountId: ids.srcAcct, sourceCustomerId: ids.alice, destinationAccountId: 'clearing-1' }, [[ids.alice, 'DEBIT']]],
    ['internal cash movement (no customer at all)', { type: 'CASH_TRANSFER', sourceAccountId: 'vault', destinationAccountId: 'drawer' }, []],
  ])('%s: only customer sides are told', (_label, fields, expected) => {
    const out = deliveries('transaction.completed.v1', envelope({ transactionId: ids.tx, amountInPaise: '5000', ...fields }));
    expect(out.map((d) => [d.kind === 'user' && d.userId, d.event.data.direction])).toEqual(expected);
  });

  it('payment.updated.v1: the customer (replayable) and the BANK_ADMIN role, with only topUpId, status, amount and account', () => {
    const out = deliveries(
      'payment.updated.v1',
      envelope({ topUpId: 'tu-1', customerId: ids.alice, accountId: ids.dstAcct, amountInPaise: '50000', status: 'CREDITED', previousStatus: 'CAPTURED', method: 'upi', failureReason: 'x' })
    );
    const event = { type: 'payment.updated', at: '2026-10-28T09:59:58.000Z', data: { topUpId: 'tu-1', status: 'CREDITED', amountInPaise: '50000', accountId: ids.dstAcct } };
    expect(out).toEqual([
      { kind: 'user', userId: ids.alice, dedupeKey: ids.event, event },
      { kind: 'role', role: 'BANK_ADMIN', envelopeId: `r-${ids.event}`, event },
    ]);
  });

  it('fraud.alert.created.v1: staff roles FRAUD_ANALYST, BANK_ADMIN and SUPPORT, never the customer, without the rule text', () => {
    const out = deliveries(
      'fraud.alert.created.v1',
      envelope({ alertId: 'al-1', transactionId: ids.tx, accountId: ids.srcAcct, severity: 'HIGH', reason: '[OUTBOUND] amount above threshold' })
    );
    expect(out.map((d) => d.kind === 'role' && d.role)).toEqual(['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT']);
    expect(out.every((d) => d.kind === 'role' && d.envelopeId === `r-${ids.event}`)).toBe(true);
    expect(out[0].event).toEqual({ type: 'fraud.alert', at: '2026-10-28T09:59:58.000Z', data: { alertId: 'al-1', severity: 'HIGH', accountId: ids.srcAcct } });
  });

  it('account.status.changed.v1: the customer, with account and new status only', () => {
    const out = deliveries('account.status.changed.v1', envelope({ accountId: ids.srcAcct, customerId: ids.alice, previousStatus: 'ACTIVE', status: 'FROZEN', changedBy: 'admin-1' }));
    expect(out).toEqual([{ kind: 'user', userId: ids.alice, dedupeKey: ids.event, event: { type: 'account.status', at: '2026-10-28T09:59:58.000Z', data: { accountId: ids.srcAcct, status: 'FROZEN' } } }]);
  });

  it('beneficiary.added.v1: the customer gets payee.added (no account digits); the nickname is cleaned', () => {
    const out = deliveries(
      'beneficiary.added.v1',
      envelope({ customerId: ids.alice, beneficiaryId: 'ben-1', accountNumberLast4: '1234', nickname: '  Mom‮\n\nnew ', activatesAt: '2026-10-28T11:00:00Z' })
    );
    expect(out).toEqual([
      { kind: 'user', userId: ids.alice, dedupeKey: ids.event, event: { type: 'payee.added', at: '2026-10-28T09:59:58.000Z', data: { beneficiaryId: 'ben-1', nickname: 'Mom new', activatesAt: '2026-10-28T11:00:00.000Z' } } },
    ]);
  });

  it('uses the event time as `at`, or now when the producer sent none', () => {
    const out = deliveries('account.status.changed.v1', { eventId: ids.event, accountId: 'a', customerId: 'c', status: 'ACTIVE' });
    expect(out[0].event.at).toBe(NOW.toISOString());
  });

  it.each([
    ['not an object', 'transaction.completed.v1', 'nope'],
    ['an array', 'transaction.completed.v1', []],
    ['no eventId', 'account.status.changed.v1', { accountId: 'a', customerId: 'c', status: 'FROZEN' }],
    ['a customer id that would reach another key (":")', 'account.status.changed.v1', envelope({ accountId: 'a', customerId: 'c:*', status: 'FROZEN' })],
    ['a non-numeric amount', 'transaction.completed.v1', envelope({ transactionId: ids.tx, type: 'TRANSFER', amountInPaise: '1e3', destinationAccountId: 'a', destinationCustomerId: 'c' })],
    ['a negative amount', 'payment.updated.v1', envelope({ topUpId: 't', customerId: 'c', accountId: 'a', amountInPaise: -5, status: 'CREDITED' })],
    ['a lowercase status', 'payment.updated.v1', envelope({ topUpId: 't', customerId: 'c', accountId: 'a', amountInPaise: '5', status: 'credited' })],
    ['a customer without an account on one side', 'transaction.completed.v1', envelope({ transactionId: ids.tx, type: 'TRANSFER', amountInPaise: '5', sourceCustomerId: 'c' })],
    ['a fraud alert without severity', 'fraud.alert.created.v1', envelope({ alertId: 'al', accountId: 'a' })],
    ['an invalid activation date', 'beneficiary.added.v1', envelope({ customerId: 'c', beneficiaryId: 'b', nickname: 'x', activatesAt: 'tomorrow' })],
    ['an unknown topic', 'user.registered.v1', envelope({ userId: 'u' })],
  ])('MALFORMED (%s): reported, never thrown', (_label, topic, payload) => {
    const result = mapEvent(topic, payload, NOW);
    expect(result.ok).toBe(false);
  });
});
