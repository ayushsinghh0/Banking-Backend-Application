import request from 'supertest';
import { BadGatewayError, generateJwtKeyPair, InMemoryTokenStateStore, signAccessToken, UserRole } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.LEDGER_INTERNAL_TOKEN = 'l'.repeat(40);
process.env.CUSTOMER_INTERNAL_TOKEN = 'c'.repeat(40);

import { createApp } from '../src/app';

const ALICE = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';
const ACCOUNT_ID = '5d1c8a43-7b0e-4a55-8f4c-2e9a3c1d7b02';
const ACCOUNT_NUMBER = '200000000006';

const tokenFor = (role: UserRole, sub = `${role.toLowerCase()}-user`) =>
  signAccessToken({ sub, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: role !== 'CUSTOMER', sessionId: `s-${sub}` });

describe('Account HTTP routes', () => {
  let stored: any;
  let prisma: any;
  let ledger: any;
  let app: any;

  beforeEach(() => {
    stored = {
      id: ACCOUNT_ID,
      accountNumber: ACCOUNT_NUMBER,
      customerId: ALICE,
      accountType: 'SAVINGS',
      status: 'ACTIVE',
      currency: 'INR',
      dailyLimit: 20000n,
      bankLimitCeiling: 20000n,
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma = {
      bankAccount: {
        findUnique: jest.fn(({ where }: any) =>
          where.id === stored.id || where.accountNumber === stored.accountNumber ? stored : null
        ),
        findMany: jest.fn(async () => [stored]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(({ data }: any) => ({ version: 1, bankLimitCeiling: null, ...data, createdAt: new Date(), updatedAt: new Date() })),
      },
      staffAccessLog: { create: jest.fn() },
      outboxEvent: { create: jest.fn() },
      auditLog: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma.$transaction = jest.fn((cb: any) => cb(prisma));
    ledger = {
      provisionAccount: jest.fn().mockResolvedValue(undefined),
      updateAccount: jest.fn().mockResolvedValue({ applied: true }),
      closeAccount: jest.fn(),
      getAccount: jest.fn(),
      getAccounts: jest.fn().mockResolvedValue([]),
    };
    app = createApp(prisma, {
      tokenState: new InMemoryTokenStateStore(),
      ledgerClient: ledger,
      customerClient: { getKycStatus: jest.fn().mockResolvedValue('VERIFIED') },
    }).app;
  });

  describe('GET /api/v1/accounts/lookup', () => {
    it('returns only the identifying fields to staff, and records the lookup', async () => {
      const res = await request(app).get(`/api/v1/accounts/lookup?accountNumber=${ACCOUNT_NUMBER}`).set('Authorization', `Bearer ${tokenFor('TELLER')}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { id: ACCOUNT_ID, accountNumber: ACCOUNT_NUMBER, customerId: ALICE, accountType: 'SAVINGS', status: 'ACTIVE' },
      });
      expect(prisma.staffAccessLog.create).toHaveBeenCalledWith({
        data: { actorId: 'teller-user', actorRole: 'TELLER', customerId: ALICE, accountId: ACCOUNT_ID, action: 'LOOKUP_ACCOUNT' },
      });
    });

    it('is open to every staff role and closed to customers (403)', async () => {
      for (const role of ['SUPPORT', 'BANK_ADMIN', 'KYC_OFFICER', 'FRAUD_ANALYST'] as const) {
        const res = await request(app).get(`/api/v1/accounts/lookup?accountNumber=${ACCOUNT_NUMBER}`).set('Authorization', `Bearer ${tokenFor(role)}`);
        expect(res.status).toBe(200);
      }
      const asCustomer = await request(app).get(`/api/v1/accounts/lookup?accountNumber=${ACCOUNT_NUMBER}`).set('Authorization', `Bearer ${tokenFor('CUSTOMER', ALICE)}`);
      expect(asCustomer.status).toBe(403);
    });

    it('validates the number (12 digits) and answers 404 NOT_FOUND for an unknown one', async () => {
      const staff = `Bearer ${tokenFor('SUPPORT')}`;
      for (const bad of ['12345', 'abcdefghijkl', '2000000000061', '']) {
        expect((await request(app).get(`/api/v1/accounts/lookup?accountNumber=${bad}`).set('Authorization', staff)).status).toBe(400);
      }
      expect((await request(app).get('/api/v1/accounts/lookup').set('Authorization', staff)).status).toBe(400);
      const unknown = await request(app).get('/api/v1/accounts/lookup?accountNumber=200000000014').set('Authorization', staff);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('NOT_FOUND');
      expect(prisma.staffAccessLog.create).not.toHaveBeenCalled();
    });
  });

  describe('account view', () => {
    it('exposes the bank-imposed ceiling as bankLimitCeilingPaise (string or null)', async () => {
      const res = await request(app).get(`/api/v1/accounts/${ACCOUNT_ID}`).set('Authorization', `Bearer ${tokenFor('CUSTOMER', ALICE)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ dailyLimitPaise: '20000', bankLimitCeilingPaise: '20000' }));
      expect(res.body.data).not.toHaveProperty('bankLimitCeiling');

      stored.bankLimitCeiling = null;
      const list = await request(app).get('/api/v1/accounts').set('Authorization', `Bearer ${tokenFor('CUSTOMER', ALICE)}`);
      expect(list.body.data[0].bankLimitCeilingPaise).toBeNull();
    });

    it('staff detail and list reads are recorded', async () => {
      const staff = `Bearer ${tokenFor('SUPPORT')}`;
      expect((await request(app).get(`/api/v1/accounts/${ACCOUNT_ID}`).set('Authorization', staff)).status).toBe(200);
      expect((await request(app).get(`/api/v1/accounts?customerId=${ALICE}`).set('Authorization', staff)).status).toBe(200);
      expect(prisma.staffAccessLog.create.mock.calls.map(([args]: any) => args.data.action)).toEqual(['VIEW_ACCOUNT', 'LIST_ACCOUNTS']);
    });
  });

  describe('POST /api/v1/accounts', () => {
    it('AFTER COMMIT: answers 201 with the account even if the ledger activation fails', async () => {
      ledger.updateAccount.mockRejectedValue(new BadGatewayError('Ledger service is unreachable'));
      const res = await request(app).post('/api/v1/accounts').set('Authorization', `Bearer ${tokenFor('CUSTOMER', ALICE)}`).send({});
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(expect.objectContaining({ customerId: ALICE, bankLimitCeilingPaise: null }));
      expect(res.body.data.accountNumber).toMatch(/^\d{12}$/);
    });
  });
});
