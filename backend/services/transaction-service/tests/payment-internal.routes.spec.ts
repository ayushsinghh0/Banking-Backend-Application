import express from 'express';
import request from 'supertest';
import { HttpError, INTERNAL_TOKEN_HEADER, errorHandlerMiddleware } from '@banksphere/common';

const TOKEN = 'p'.repeat(40);
process.env.PAYMENT_LEDGER_INTERNAL_TOKEN = TOKEN;

import { createPaymentInternalRouter } from '../src/routes/payment-internal.routes';

const TOPUP = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const REFUND = '6e5d4c3b-2a19-4087-b654-3210fedcba98';
const ACCOUNT = '5d1c8a43-7b0e-4a55-8f4c-2e9a3c1d7b02';
const CUSTOMER = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';

const creditBody = { topUpId: TOPUP, accountId: ACCOUNT, customerId: CUSTOMER, amountPaise: '10000', providerPaymentId: 'pay_N7xKzT1ab2CdEf' };
const refundBody = { refundId: REFUND, topUpId: TOPUP, accountId: ACCOUNT, customerId: CUSTOMER, amountPaise: '4000' };

function setup() {
  const posting = { transactionId: 'txn-1', referenceId: `TOPUP-${TOPUP}`, replayed: false };
  const service = {
    getAccount: jest.fn().mockResolvedValue({ accountId: ACCOUNT, customerId: CUSTOMER, accountNumberLast4: '0006', isActive: true, closed: false }),
    credit: jest.fn().mockResolvedValue(posting),
    refund: jest.fn().mockResolvedValue({ ...posting, referenceId: `TOPUP-REFUND-${REFUND}` }),
    reverseRefund: jest.fn().mockResolvedValue({ ...posting, referenceId: `TOPUP-REFUND-REV-${REFUND}` }),
  };
  const app = express();
  app.use(express.json());
  app.use('/internal/v1/payments', createPaymentInternalRouter(service as any));
  app.use(errorHandlerMiddleware);
  const call = (method: 'get' | 'post', path: string, body?: unknown) => {
    const req = request(app)[method](`/internal/v1/payments${path}`).set(INTERNAL_TOKEN_HEADER, TOKEN);
    return body === undefined ? req : req.send(body as object);
  };
  return { service, call };
}

describe('POST /internal/v1/payments/credits', () => {
  it('201 with { transactionId, referenceId, replayed } for a new posting, 200 for a replay; amounts become BigInt', async () => {
    const { service, call } = setup();
    const res = await call('post', '/credits', creditBody);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { transactionId: 'txn-1', referenceId: `TOPUP-${TOPUP}`, replayed: false } });
    expect(service.credit).toHaveBeenCalledWith({ ...creditBody, amountPaise: 10_000n });

    service.credit.mockResolvedValueOnce({ transactionId: 'txn-1', referenceId: `TOPUP-${TOPUP}`, replayed: true });
    const replay = await call('post', '/credits', creditBody);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
  });

  it.each([
    ['an unknown field', { ...creditBody, extra: 1 }],
    ['a zero amount', { ...creditBody, amountPaise: '0' }],
    ['a negative amount', { ...creditBody, amountPaise: '-5' }],
    ['a fractional amount', { ...creditBody, amountPaise: '10.5' }],
    ['a numeric amount (precision)', { ...creditBody, amountPaise: 10000 }],
    ['an exponent', { ...creditBody, amountPaise: '1e6' }],
    ['19 digits', { ...creditBody, amountPaise: '1000000000000000000' }],
    ['a leading zero', { ...creditBody, amountPaise: '010' }],
    ['a top-up id that is not a UUID', { ...creditBody, topUpId: 'abc' }],
    ['a customer id that is not a UUID', { ...creditBody, customerId: 'cust-1' }],
    ['a provider payment id with spaces', { ...creditBody, providerPaymentId: 'pay 1' }],
    ['a missing provider payment id', (({ providerPaymentId: _omit, ...rest }) => rest)(creditBody)],
  ])('400 VALIDATION_ERROR for %s, and nothing is posted', async (_label, body) => {
    const { service, call } = setup();
    const res = await call('post', '/credits', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(service.credit).not.toHaveBeenCalled();
  });

  it('passes the ledger’s refusals through with their status and code', async () => {
    const { service, call } = setup();
    service.credit.mockRejectedValueOnce(new HttpError(409, 'ACCOUNT_NOT_CREDITABLE', 'no'));
    const res = await call('post', '/credits', creditBody);
    expect([res.status, res.body.error.code]).toEqual([409, 'ACCOUNT_NOT_CREDITABLE']);
  });
});

describe('POST /internal/v1/payments/refunds and /refunds/:refundId/reverse', () => {
  it('refund: strict body, 201 / 200 on replay, 409 INSUFFICIENT_FUNDS passed through', async () => {
    const { service, call } = setup();
    expect((await call('post', '/refunds', refundBody)).status).toBe(201);
    expect(service.refund).toHaveBeenCalledWith({ ...refundBody, amountPaise: 4_000n });
    expect((await call('post', '/refunds', { ...refundBody, providerPaymentId: 'pay_1' })).status).toBe(400);
    expect((await call('post', '/refunds', { ...refundBody, refundId: 'rfnd_123' })).status).toBe(400);
    service.refund.mockRejectedValueOnce(new HttpError(409, 'INSUFFICIENT_FUNDS', 'no'));
    const refused = await call('post', '/refunds', refundBody);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'INSUFFICIENT_FUNDS']);
  });

  it('reverse: no body (or {}), refund id in the path', async () => {
    const { service, call } = setup();
    expect((await call('post', `/refunds/${REFUND}/reverse`)).status).toBe(201);
    expect((await call('post', `/refunds/${REFUND}/reverse`, {})).status).toBe(201);
    expect(service.reverseRefund).toHaveBeenCalledWith(REFUND);
    expect((await call('post', `/refunds/${REFUND}/reverse`, { amountPaise: '1' })).status).toBe(400);
    expect((await call('post', '/refunds/not-a-uuid/reverse', {})).status).toBe(400);
    expect(service.reverseRefund).toHaveBeenCalledTimes(2);
  });
});

describe('GET /internal/v1/payments/accounts/:accountId', () => {
  it('returns the account view; a malformed id is a 400', async () => {
    const { call } = setup();
    const res = await call('get', `/accounts/${ACCOUNT}`);
    expect(res.body).toEqual({ success: true, data: { accountId: ACCOUNT, customerId: CUSTOMER, accountNumberLast4: '0006', isActive: true, closed: false } });
    expect((await call('get', '/accounts/123')).status).toBe(400);
  });
});
