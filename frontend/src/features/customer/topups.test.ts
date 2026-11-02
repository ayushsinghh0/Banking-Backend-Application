import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { methodLabel, topUpOutcome, topUpProblem, TOP_UP_STATUS_LABEL } from './topups';

const apiError = (status: number, code: string, message = code) => new ApiError({ status, code, message });

describe('topUpOutcome', () => {
  it('groups the states the way the customer experiences them', () => {
    expect(['CREATED', 'PENDING', 'CAPTURED'].map((s) => topUpOutcome(s as never))).toEqual(['pending', 'pending', 'pending']);
    expect(topUpOutcome('CREDITED')).toBe('credited');
    expect(topUpOutcome('FAILED')).toBe('failed');
    expect(topUpOutcome('EXPIRED')).toBe('failed');
    expect(topUpOutcome('CANCELLED')).toBe('cancelled');
    expect(['CREDIT_BLOCKED', 'REFUND_PENDING', 'REFUNDED'].map((s) => topUpOutcome(s as never))).toEqual(['returned', 'returned', 'returned']);
  });

  it('names every status in plain words', () => {
    expect(TOP_UP_STATUS_LABEL.CREATED).toBe('Waiting for payment');
    expect(TOP_UP_STATUS_LABEL.CREDIT_BLOCKED).toBe('On hold');
  });
});

describe('methodLabel', () => {
  it('humanises Razorpay method codes', () => {
    expect(methodLabel('upi')).toBe('UPI');
    expect(methodLabel('netbanking')).toBe('Net banking');
    expect(methodLabel('card')).toBe('Card');
    expect(methodLabel('cardless_emi')).toBe('Cardless emi');
    expect(methodLabel(null)).toBeNull();
  });
});

describe('topUpProblem', () => {
  it('explains the refusals that are specific to adding money', () => {
    expect(topUpProblem(apiError(403, 'KYC_NOT_VERIFIED'))).toMatchObject({ title: 'Identity verification pending' });
    expect(topUpProblem(apiError(422, 'TOPUP_DAILY_LIMIT_EXCEEDED'))).toMatchObject({ title: 'Daily limit reached', field: 'amount' });
    expect(topUpProblem(apiError(422, 'DAILY_LIMIT_EXCEEDED'))).toMatchObject({ title: 'Daily limit reached' });
    expect(topUpProblem(apiError(409, 'TOO_MANY_OPEN_TOP_UPS'))).toMatchObject({ title: 'Too many payments in progress' });
    expect(topUpProblem(apiError(409, 'ACCOUNT_NOT_CREDITABLE'))).toMatchObject({ title: 'Account unavailable', field: 'accountId' });
    expect(topUpProblem(apiError(422, 'ACCOUNT_INACTIVE'))).toMatchObject({ field: 'accountId' });
    expect(topUpProblem(apiError(422, 'AMOUNT_TOO_SMALL'))).toMatchObject({ field: 'amount' });
    expect(topUpProblem(apiError(422, 'AMOUNT_TOO_LARGE'))).toMatchObject({ field: 'amount' });
  });

  it('falls back to the shared catalog', () => {
    expect(topUpProblem(apiError(503, 'SERVICE_UNAVAILABLE'))).toMatchObject({ title: 'Temporarily unavailable' });
    expect(topUpProblem(new Error('x'))).toMatchObject({ title: 'Something went wrong' });
    expect(topUpProblem(apiError(400, 'VALIDATION_ERROR'))).toMatchObject({ title: 'Check the highlighted fields' });
  });
});
