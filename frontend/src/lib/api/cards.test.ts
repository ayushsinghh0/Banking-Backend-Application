import { describe, expect, it } from 'vitest';
import { normalizeCard, normalizeCards } from './cards';

describe('normalizeCard', () => {
  it('accepts every card type in the flat shape', () => {
    expect(normalizeCard({ type: 'accounts', accounts: [{ id: 'a1', label: 'Savings', last4: '6789', balancePaise: '1050' }] })).toEqual({
      type: 'accounts',
      accounts: [{ id: 'a1', label: 'Savings', last4: '6789', balancePaise: '1050' }],
    });
    expect(normalizeCard({ type: 'help', title: 'Add a payee', steps: ['Open Payees', 'Add'] })).toEqual({
      type: 'help',
      title: 'Add a payee',
      steps: ['Open Payees', 'Add'],
    });
    expect(normalizeCard({ type: 'payees', items: [{ nickname: 'Ravi', last4: '5432', active: true }] })).toMatchObject({ type: 'payees' });
    expect(normalizeCard({ type: 'topups', items: [{ id: 't1', amountPaise: '50000', status: 'CREDITED', at: '2026-10-27T09:00:00Z' }] })).toMatchObject({
      type: 'topups',
    });
  });

  it('accepts the payload nested under data, and a kind instead of a type', () => {
    expect(normalizeCard({ type: 'help', data: { title: 'T', steps: ['one'] } })).toEqual({ type: 'help', title: 'T', steps: ['one'] });
    expect(normalizeCard({ kind: 'help', title: 'T', steps: [] })).toEqual({ type: 'help', title: 'T', steps: [] });
  });

  it('normalises transaction directions and amounts', () => {
    const card = normalizeCard({
      type: 'transactions',
      accountLabel: 'Savings ••••6789',
      items: [
        { id: '1', at: '2026-10-27T09:00:00Z', description: 'Salary', direction: 'in', amountPaise: '100' },
        { id: '2', at: '2026-10-27T09:00:00Z', description: 'Rent', direction: 'DEBIT', amountPaise: 250 },
        { id: '3', at: '2026-10-27T09:00:00Z', description: 'Bad', direction: 'out', amountPaise: '1.5' },
      ],
    });
    expect(card).toEqual({
      type: 'transactions',
      accountLabel: 'Savings ••••6789',
      items: [
        { id: '1', at: '2026-10-27T09:00:00Z', description: 'Salary', direction: 'CREDIT', amountPaise: '100' },
        { id: '2', at: '2026-10-27T09:00:00Z', description: 'Rent', direction: 'DEBIT', amountPaise: '250' },
      ],
    });
  });

  it('keeps only the known fields of a transfer draft', () => {
    expect(
      normalizeCard({ type: 'transferDraft', fromAccountId: 'a1', toPayeeNickname: 'Ravi', amountPaise: '250000', note: 'Rent', extra: '<b>x</b>' })
    ).toEqual({ type: 'transferDraft', fromAccountId: 'a1', toPayeeNickname: 'Ravi', amountPaise: '250000', note: 'Rent' });
    expect(normalizeCard({ type: 'transferDraft', fromAccountId: 'a1', amountPaise: 'lots' })).toEqual({ type: 'transferDraft', fromAccountId: 'a1' });
  });

  it('builds a spending card with day buckets', () => {
    expect(
      normalizeCard({ type: 'spending', days: 7, inPaise: '100', outPaise: '50', byDay: [{ date: '2026-10-27', inPaise: '100', outPaise: '50' }] })
    ).toEqual({ type: 'spending', days: 7, inPaise: '100', outPaise: '50', byDay: [{ date: '2026-10-27', inPaise: '100', outPaise: '50' }] });
  });

  it('rejects unknown types and malformed cards', () => {
    expect(normalizeCard(null)).toBeNull();
    expect(normalizeCard('accounts')).toBeNull();
    expect(normalizeCard({ type: 'html', html: '<script>' })).toBeNull();
    expect(normalizeCard({ type: 'accounts', accounts: 'nope' })).toBeNull();
    expect(normalizeCard({ type: 'help', title: 5, steps: [] })).toBeNull();
    expect(normalizeCard({ type: 'spending', days: 7 })).toBeNull();
    expect(normalizeCard({ type: 'transferDraft' })).toBeNull();
  });

  it('drops the bad cards from a list', () => {
    expect(normalizeCards([{ type: 'help', title: 'T', steps: [] }, { type: 'nope' }])).toHaveLength(1);
    expect(normalizeCards(undefined)).toEqual([]);
    expect(normalizeCards({ type: 'help' })).toEqual([]);
  });
});
