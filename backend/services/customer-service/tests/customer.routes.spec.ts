import request from 'supertest';
import { generateJwtKeyPair, InMemoryTokenStateStore, signAccessToken, UserRole } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.CUSTOMER_INTERNAL_TOKEN = 'c'.repeat(40);

import { createApp } from '../src/app';

const ALICE = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';

const tokenFor = (role: UserRole, sub = `${role.toLowerCase()}-user`) =>
  signAccessToken({ sub, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa: role !== 'CUSTOMER', sessionId: `s-${sub}` });

/** YYYY-MM-DD for the date `years` years (and `days` days) before today (UTC) */
function yearsAgo(years: number, days = 0): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Customer HTTP routes', () => {
  let prisma: any;
  let app: any;
  const asAlice = `Bearer ${tokenFor('CUSTOMER', ALICE)}`;

  beforeEach(() => {
    prisma = {
      customerProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }: any) => ({ id: 'cp-1', kycStatus: 'PENDING', version: 1, createdAt: new Date(), updatedAt: new Date(), ...data })),
        update: jest.fn(({ data }: any) => ({ id: 'cp-1', userId: ALICE, kycStatus: 'PENDING', version: 2, ...data })),
      },
      kycEvent: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      staffAccessLog: { create: jest.fn(), createMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma.$transaction = jest.fn((cb: any) => cb(prisma));
    app = createApp(prisma, { tokenState: new InMemoryTokenStateStore() }).app;
  });

  const createMe = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/customers/me').set('Authorization', asAlice).send({ fullName: 'Alice Smith', phoneNumber: '+919876543210', ...body });
  const created = () => prisma.customerProfile.create.mock.calls[0][0].data;

  describe('profile validation', () => {
    it('DATE OF BIRTH: accepts YYYY-MM-DD and full ISO date-times, stored as before', async () => {
      expect((await createMe({ dateOfBirth: '1990-05-17' })).status).toBe(201);
      expect(created().dateOfBirth).toEqual(new Date('1990-05-17T00:00:00.000Z'));
      prisma.customerProfile.create.mockClear();
      expect((await createMe({ dateOfBirth: '1990-05-17T00:00:00.000Z' })).status).toBe(201);
      expect(created().dateOfBirth).toEqual(new Date('1990-05-17T00:00:00.000Z'));
    });

    it('DATE OF BIRTH: refuses future, year-0000, impossible and implausible dates (age must be 18-120)', async () => {
      for (const dateOfBirth of ['2099-01-01', '0000-01-01', '0000-01-01T00:00:00.000Z', '2001-02-30', 'yesterday', yearsAgo(18, 1), yearsAgo(121, -1)]) {
        const res = await createMe({ dateOfBirth });
        expect({ dateOfBirth, status: res.status }).toEqual({ dateOfBirth, status: 400 });
      }
      expect(prisma.customerProfile.create).not.toHaveBeenCalled();
      for (const dateOfBirth of [yearsAgo(18, -1), yearsAgo(121, 1)]) {
        expect({ dateOfBirth, status: (await createMe({ dateOfBirth })).status }).toEqual({ dateOfBirth, status: 201 });
      }
    });

    it('NAMES: NFKC-normalised, spaces collapsed; letters, marks, spaces and . \' - only', async () => {
      const accepted: Array<[string, string]> = [
        ['Ａｌｉｃｅ Smith', 'Alice Smith'], // full-width letters
        ['  Alice    van   der Berg ', 'Alice van der Berg'],
        ["Anne-Marie O'Neil Jr.", "Anne-Marie O'Neil Jr."],
        ['O’Brien Kelly', "O'Brien Kelly"], // typographic apostrophe
        ['José Ñuñez', 'José Ñuñez'], // decomposed accents are composed
        ['अनीता शर्मा', 'अनीता शर्मा'], // Devanagari (combining marks)
        ['Alice Smith', 'Alice Smith'], // no-break space
      ];
      for (const [input, stored] of accepted) {
        prisma.customerProfile.create.mockClear();
        expect({ input, status: (await createMe({ fullName: input })).status }).toEqual({ input, status: 201 });
        expect(created().fullName).toBe(stored);
      }
    });

    it('NAMES: refuses zero-width, bidi, control characters, digits and symbols', async () => {
      const rejected = [
        'Ali​ce Smith', // zero-width space
        'Alice‍ Smith', // zero-width joiner
        'Alice ‮Smith', // right-to-left override
        'Alice ⁦Smith⁩', // isolates
        'Alice\u0007 Smith', // control
        'Alice\nSmith',
        'Alice\tSmith',
        'E2E Alice',
        '<script>',
        'Alice_Smith',
        '--',
        'A',
        'A'.repeat(101),
      ];
      for (const fullName of rejected) {
        expect({ fullName, status: (await createMe({ fullName })).status }).toEqual({ fullName, status: 400 });
      }
      expect(prisma.customerProfile.create).not.toHaveBeenCalled();
    });

    it('ADDRESS: trimmed, blank means absent, at most 255 characters', async () => {
      expect((await createMe({ address: '  12 Main Street, Pune  ' })).status).toBe(201);
      expect(created().address).toBe('12 Main Street, Pune');
      prisma.customerProfile.create.mockClear();
      expect((await createMe({ address: '   ' })).status).toBe(201);
      expect(created().address).toBeUndefined();
      expect((await createMe({ address: 'x'.repeat(256) })).status).toBe(400);
    });

    it('PATCH /me applies the same rules; a blank address leaves the stored one unchanged', async () => {
      prisma.customerProfile.findUnique.mockResolvedValue({ userId: ALICE, fullName: 'Alice Smith', address: '12 Main Street', dateOfBirth: null, kycStatus: 'VERIFIED' });
      const res = await request(app).patch('/api/v1/customers/me').set('Authorization', asAlice).send({ address: ' ', phoneNumber: '+919876500000' });
      expect(res.status).toBe(200);
      expect(prisma.customerProfile.update.mock.calls[0][0].data).not.toHaveProperty('address');
      expect(prisma.kycEvent.create).not.toHaveBeenCalled();

      for (const body of [{ fullName: 'Mallory‮' }, { dateOfBirth: '2099-01-01' }, { address: 'y'.repeat(300) }]) {
        expect((await request(app).patch('/api/v1/customers/me').set('Authorization', asAlice).send(body)).status).toBe(400);
      }
    });
  });

  describe('GET /api/v1/customers (staff search)', () => {
    const profile = {
      id: 'cp-1',
      userId: ALICE,
      fullName: 'Alice Smith',
      phoneNumber: '+919876543210',
      address: null,
      dateOfBirth: new Date('1990-05-17T00:00:00.000Z'),
      kycStatus: 'PENDING',
      version: 3,
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
      updatedAt: new Date('2026-10-02T10:00:00.000Z'),
    };

    it('is for KYC_OFFICER, BANK_ADMIN and SUPPORT only', async () => {
      for (const role of ['KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'] as const) {
        expect({ role, status: (await request(app).get('/api/v1/customers').set('Authorization', `Bearer ${tokenFor(role)}`)).status }).toEqual({ role, status: 200 });
      }
      for (const role of ['CUSTOMER', 'TELLER', 'FRAUD_ANALYST'] as const) {
        expect({ role, status: (await request(app).get('/api/v1/customers').set('Authorization', `Bearer ${tokenFor(role)}`)).status }).toEqual({ role, status: 403 });
      }
      expect((await request(app).get('/api/v1/customers')).status).toBe(401);
    });

    it('returns the same profile shape as GET /customers/:userId, with the pagination used', async () => {
      prisma.customerProfile.findMany.mockResolvedValue([profile]);
      prisma.customerProfile.findUnique.mockResolvedValue(profile);
      const staff = `Bearer ${tokenFor('KYC_OFFICER')}`;
      const list = await request(app).get('/api/v1/customers?kycStatus=PENDING&q=%20alice%20').set('Authorization', staff);
      const single = await request(app).get(`/api/v1/customers/${ALICE}`).set('Authorization', staff);
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ success: true, data: [single.body.data], pagination: { limit: 20, offset: 0 } });
      expect(prisma.customerProfile.findMany.mock.calls[0][0].where).toEqual({
        kycStatus: 'PENDING',
        OR: [{ fullName: { contains: 'alice', mode: 'insensitive' } }, { phoneNumber: { contains: 'alice' } }],
      });
      expect(prisma.staffAccessLog.createMany).toHaveBeenCalledWith({
        data: [{ actorId: 'kyc_officer-user', actorRole: 'KYC_OFFICER', userId: ALICE, action: 'LIST_CUSTOMERS' }],
      });
    });

    it('pagination has the shared caps (limit 100, offset 10000)', async () => {
      const res = await request(app).get('/api/v1/customers?limit=1000&offset=99999999').set('Authorization', `Bearer ${tokenFor('SUPPORT')}`);
      expect(res.body.pagination).toEqual({ limit: 100, offset: 10000 });
      expect(prisma.customerProfile.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ take: 100, skip: 10000 }));
    });

    it('validates kycStatus and q (max 100 after trimming; blank means no search)', async () => {
      const staff = `Bearer ${tokenFor('SUPPORT')}`;
      expect((await request(app).get('/api/v1/customers?kycStatus=APPROVED').set('Authorization', staff)).status).toBe(400);
      expect((await request(app).get(`/api/v1/customers?q=${'a'.repeat(101)}`).set('Authorization', staff)).status).toBe(400);
      expect((await request(app).get('/api/v1/customers?q=a&q=b').set('Authorization', staff)).status).toBe(400);
      expect((await request(app).get(`/api/v1/customers?q=%20${'a'.repeat(100)}%20`).set('Authorization', staff)).status).toBe(200);
      prisma.customerProfile.findMany.mockClear();
      expect((await request(app).get('/api/v1/customers?q=%20%20').set('Authorization', staff)).status).toBe(200);
      expect(prisma.customerProfile.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('does not shadow /me or /:userId', async () => {
      prisma.customerProfile.findUnique.mockResolvedValue(profile);
      const me = await request(app).get('/api/v1/customers/me').set('Authorization', asAlice);
      expect(me.status).toBe(200);
      expect(me.body.data.userId).toBe(ALICE);
      const byId = await request(app).get(`/api/v1/customers/${ALICE}`).set('Authorization', `Bearer ${tokenFor('SUPPORT')}`);
      expect(byId.status).toBe(200);
      expect(prisma.staffAccessLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'VIEW_PROFILE' }) });
      expect(prisma.customerProfile.findMany).not.toHaveBeenCalled();
    });
  });
});
