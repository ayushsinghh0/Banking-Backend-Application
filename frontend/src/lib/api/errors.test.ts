import { describe, expect, it } from 'vitest';
import { ApiError, describeError } from './errors';

describe('describeError', () => {
  it('gives a specific, actionable message for known codes', () => {
    const d = describeError(new ApiError({ status: 422, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' }));
    expect(d.title).toBe('Not enough balance');
    expect(d.description).toMatch(/available balance/i);
  });

  it('falls back to the server message for unknown codes', () => {
    const d = describeError(new ApiError({ status: 409, code: 'SOMETHING_NEW', message: 'A new server rule' }));
    expect(d.title).toBe('Request not completed');
    expect(d.description).toBe('A new server rule');
  });

  it('includes the correlation id as a support reference for server errors', () => {
    const d = describeError(
      new ApiError({ status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'boom', correlationId: 'corr-99' })
    );
    expect(d.reference).toBe('corr-99');
  });

  it('describes unknown thrown values safely', () => {
    expect(describeError(new Error('x')).title).toBe('Something went wrong');
    expect(describeError('weird').title).toBe('Something went wrong');
  });

  it('flags step-up and retryable errors', () => {
    expect(new ApiError({ status: 403, code: 'STEP_UP_REQUIRED', message: '' }).requiresStepUp).toBe(true);
    expect(new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: '' }).isRetryable).toBe(true);
    expect(new ApiError({ status: 400, code: 'VALIDATION_ERROR', message: '' }).isRetryable).toBe(false);
  });

  it('shows the rate-limit wait time when the server gives one', () => {
    const d = describeError(
      new ApiError({ status: 429, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many', retryAfterSeconds: 120 })
    );
    expect(d.description).toMatch(/2 minutes/);
  });
});
