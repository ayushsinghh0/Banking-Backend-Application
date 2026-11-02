import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import {
  describeOpsError,
  eventLabel,
  expiryLabel,
  formatRate,
  formatSeconds,
  methodLabel,
  parseCidr,
  reportEntries,
  sourceLabel,
  summaryFigures,
  topUpStatusLabel,
} from './format';
import { aSummary } from './test/handlers';

describe('parseCidr', () => {
  it.each([
    ['203.0.113.0/24', '203.0.113.0/24'],
    [' 198.51.100.7 ', '198.51.100.7/32'],
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['2001:db8::/48', '2001:db8::/48'],
    ['2001:db8::1', '2001:db8::1/128'],
  ])('accepts %s', (input, cidr) => {
    expect(parseCidr(input)).toEqual({ ok: true, cidr });
  });

  it.each([
    ['', /enter an address/i],
    ['10.0.0.0/7', /wider than \/8/i],
    ['2001:db8::/31', /wider than \/32/i],
    ['10.0.0.0/33', /\/8 to \/32/i],
    ['2001:db8::/129', /\/32 to \/128/i],
    ['10.0.0.0/abc', /\/8 to \/32/i],
    ['300.1.1.1', /valid ipv4 or ipv6/i],
    ['10.0.0.0/8/8', /valid ipv4 or ipv6/i],
    ['fe80::1%eth0', /valid ipv4 or ipv6/i],
    ['not-an-address', /valid ipv4 or ipv6/i],
  ])('rejects %s', (input, message) => {
    const result = parseCidr(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe('labels', () => {
  it('names statuses, methods, sources and events in words', () => {
    expect(topUpStatusLabel('CREDIT_BLOCKED')).toBe('Credit blocked');
    expect(topUpStatusLabel('PENDING')).toBe('Awaiting payment');
    expect(methodLabel('upi')).toBe('UPI');
    expect(methodLabel('netbanking')).toBe('Net banking');
    expect(methodLabel('emi')).toBe('Emi');
    expect(methodLabel(null)).toBe('Not paid yet');
    expect(sourceLabel('webhook')).toBe('Razorpay webhook');
    expect(sourceLabel('some_job')).toBe('Some job');
    expect(eventLabel('IP_AUTO_BANNED')).toBe('Address banned automatically');
    expect(eventLabel('BRAND_NEW_EVENT')).toBe('Brand new event');
  });
});

describe('numbers', () => {
  it('formats durations', () => {
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(38.4)).toBe('38 s');
    expect(formatSeconds(120)).toBe('2 min');
    expect(formatSeconds(185)).toBe('3 min 5 s');
    expect(formatSeconds(3600)).toBe('1 h');
    expect(formatSeconds(3720)).toBe('1 h 2 min');
  });

  it('formats rates', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.947)).toBe('94.7%');
    expect(formatRate(1)).toBe('100%');
  });

  it('says when something expires', () => {
    const now = Date.parse('2026-10-28T04:00:00.000Z');
    expect(expiryLabel(null, now)).toBe('Never');
    expect(expiryLabel('2026-10-28T03:00:00.000Z', now)).toBe('Expired');
    expect(expiryLabel('2026-10-28T04:30:00.000Z', now)).toBe('in 30 minutes');
  });
});

describe('summaryFigures', () => {
  it('adds up today’s top-ups', () => {
    const figures = summaryFigures(
      aSummary({
        byStatus: {
          CREDITED: { count: 3, amountPaise: '100000' },
          REFUNDED: { count: 1, amountPaise: '5000' },
          PENDING: { count: 2, amountPaise: '999' },
          CREDIT_BLOCKED: { count: 1, amountPaise: '7000' },
          FAILED: { count: 4, amountPaise: '1' },
        },
      })
    );
    expect(figures).toEqual({ creditedPaise: '105000', creditedCount: 4, total: 11, open: 2, blocked: 1, refundsPending: 0 });
  });
});

describe('reportEntries', () => {
  it('flattens the reconciler’s report into labelled values', () => {
    const entries = reportEntries({
      checked: 12,
      settled: 2,
      finishedAt: '2026-10-28T04:00:00.000Z',
      ok: true,
      refunds: { checked: 1, completed: 0 },
      errors: ['x', 'y'],
      note: null,
    });
    expect(entries.map((e) => [e.label, e.value])).toEqual([
      ['Checked', '12'],
      ['Settled', '2'],
      ['Finished at', expect.stringMatching(/28 Oct 2026/)],
      ['Ok', 'Yes'],
      ['Refunds: checked', '1'],
      ['Refunds: completed', '0'],
      ['Errors', '2'],
      ['Note', '—'],
    ]);
  });
});

describe('describeOpsError', () => {
  it('uses the server’s explanation for refusals it knows about', () => {
    const error = new ApiError({ status: 409, code: 'IP_RULE_OVERLAPS_STAFF_NETWORK', message: 'The range overlaps the staff network 10.20.0.0/16' });
    expect(describeOpsError(error)).toEqual({
      title: 'Overlaps a staff network',
      description: 'The range overlaps the staff network 10.20.0.0/16',
      reference: undefined,
    });
  });

  it('falls back to the shared catalogue', () => {
    expect(describeOpsError(new ApiError({ status: 503, code: 'SERVICE_BUSY', message: 'busy', correlationId: 'c1' }))).toEqual({
      title: 'Busy right now',
      description: 'Nothing was processed. Please try again in a moment.',
      reference: 'c1',
    });
    expect(describeOpsError(new Error('boom')).title).toBe('Something went wrong');
  });

  it('explains a refund the customer’s balance can’t cover', () => {
    expect(describeOpsError(new ApiError({ status: 409, code: 'INSUFFICIENT_FUNDS', message: 'x' })).title).toBe('Not enough balance to refund');
  });

  it('keeps a specific server message for unknown refusals', () => {
    const error = new ApiError({ status: 400, code: 'SOMETHING_NEW', message: 'Rules wider than /8 are refused' });
    expect(describeOpsError(error)).toMatchObject({ title: 'Request not completed', description: 'Rules wider than /8 are refused' });
  });
});
