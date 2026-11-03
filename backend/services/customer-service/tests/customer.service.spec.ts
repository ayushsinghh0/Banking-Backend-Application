import { CustomerService } from '../src/services/customer.service';
import { ForbiddenError, HttpError } from '@banksphere/common';

// Caching is covered against a real Cache in customer-cache.spec.ts; these run with caching disabled
describe('CustomerService', () => {
  let mockPrisma: any;
  let customerService: CustomerService;

  beforeEach(() => {
    mockPrisma = {
      customerProfile: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      kycEvent: { create: jest.fn(), findMany: jest.fn() },
      staffAccessLog: { create: jest.fn(), createMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));


    customerService = new CustomerService(mockPrisma);
  });

  describe('KYC integrity', () => {
    it('KYC BYPASS: changing the name on a VERIFIED profile sends it back to PENDING and is recorded', async () => {
      mockPrisma.customerProfile.findUnique.mockResolvedValue({ userId: 'u-1', fullName: 'Alice Smith', dateOfBirth: null, kycStatus: 'VERIFIED' });
      mockPrisma.customerProfile.update.mockImplementation(({ data }: any) => ({ userId: 'u-1', kycStatus: data.kycStatus ?? 'VERIFIED', ...data }));

      const updated = await customerService.updateProfile('u-1', { fullName: 'Mallory Mule' });

      expect(mockPrisma.customerProfile.update.mock.calls[0][0].data.kycStatus).toBe('PENDING');
      expect(updated.kycStatus).toBe('PENDING');
      expect(mockPrisma.kycEvent.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ action: 'IDENTITY_CHANGED_KYC_RESET', fromStatus: 'VERIFIED', toStatus: 'PENDING' })
      );
    });

    it('changing only the phone number keeps KYC as is', async () => {
      mockPrisma.customerProfile.findUnique.mockResolvedValue({ userId: 'u-1', fullName: 'Alice Smith', dateOfBirth: null, kycStatus: 'VERIFIED' });
      mockPrisma.customerProfile.update.mockImplementation(({ data }: any) => ({ userId: 'u-1', kycStatus: 'VERIFIED', ...data }));
      await customerService.updateProfile('u-1', { phoneNumber: '+919876500000' });
      expect(mockPrisma.customerProfile.update.mock.calls[0][0].data.kycStatus).toBeUndefined();
      expect(mockPrisma.kycEvent.create).not.toHaveBeenCalled();
    });

    it('SELF-KYC: staff cannot decide their own KYC; decisions by others are audited', async () => {
      const officer = { id: 'kyc-1', email: 'k@b.com', role: 'KYC_OFFICER' as const, mfa: true };
      await expect(customerService.updateKycStatus(officer, 'kyc-1', 'VERIFIED' as any, 1)).rejects.toThrow(ForbiddenError);

      mockPrisma.customerProfile.findUnique.mockResolvedValue({ userId: 'u-1', kycStatus: 'PENDING', version: 1 });
      mockPrisma.customerProfile.findUniqueOrThrow.mockResolvedValue({ userId: 'u-1', kycStatus: 'VERIFIED', version: 2 });
      await customerService.updateKycStatus(officer, 'u-1', 'VERIFIED' as any, 1);
      expect(mockPrisma.customerProfile.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u-1', version: 1 });
      expect(mockPrisma.kycEvent.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ actorId: 'kyc-1', toStatus: 'VERIFIED', details: { reviewedVersion: 1 } })
      );
    });

    it('STALE REVIEW: a decision on a profile that changed after it was reviewed is rejected', async () => {
      const officer = { id: 'kyc-1', email: 'k@b.com', role: 'KYC_OFFICER' as const, mfa: true };
      mockPrisma.customerProfile.findUnique.mockResolvedValue({ userId: 'u-1', kycStatus: 'PENDING', version: 3 });
      mockPrisma.customerProfile.updateMany.mockResolvedValue({ count: 0 });
      await expect(customerService.updateKycStatus(officer, 'u-1', 'VERIFIED' as any, 2)).rejects.toThrow(HttpError);
      expect(mockPrisma.kycEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('staff access log', () => {
    const support = { id: 'sup-1', email: 's@b.com', role: 'SUPPORT' as const, mfa: true };

    it('KYC history (it holds identity data) is a recorded staff read', async () => {
      mockPrisma.kycEvent.findMany.mockResolvedValue([{ id: 'ev-1', userId: 'u-1' }]);
      const events = await customerService.getKycHistory(support, 'u-1');
      expect(events).toEqual([{ id: 'ev-1', userId: 'u-1' }]);
      expect(mockPrisma.staffAccessLog.create).toHaveBeenCalledWith({
        data: { actorId: 'sup-1', actorRole: 'SUPPORT', userId: 'u-1', action: 'VIEW_KYC_HISTORY' },
      });
    });

    it('NO READ WITHOUT A LOG: if the access log cannot be written, the history is not returned', async () => {
      mockPrisma.kycEvent.findMany.mockResolvedValue([{ id: 'ev-1', userId: 'u-1' }]);
      mockPrisma.staffAccessLog.create.mockRejectedValue(new Error('db down'));
      await expect(customerService.getKycHistory(support, 'u-1')).rejects.toThrow('db down');
    });
  });

  describe('listProfilesForStaff (staff search)', () => {
    const officer = { id: 'kyc-1', email: 'k@b.com', role: 'KYC_OFFICER' as const, mfa: true };
    const page = { limit: 20, offset: 40 };
    const query = () => mockPrisma.customerProfile.findMany.mock.calls[0][0];

    it('PENDING is a review queue: oldest first', async () => {
      await customerService.listProfilesForStaff(officer, { kycStatus: 'PENDING' as any }, page);
      expect(query()).toEqual({
        where: { kycStatus: 'PENDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
        skip: 40,
      });
    });

    it('anything else is newest first', async () => {
      await customerService.listProfilesForStaff(officer, {}, page);
      expect(query()).toEqual({ where: {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, skip: 40 });
      mockPrisma.customerProfile.findMany.mockClear();
      await customerService.listProfilesForStaff(officer, { kycStatus: 'VERIFIED' as any }, page);
      expect(query().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('q: a UUID is an exact user id; anything else searches names (any case) and phone numbers', async () => {
      await customerService.listProfilesForStaff(officer, { q: '0B8F2A52-0D55-4BB4-9A43-6F0D8F1F0A01' }, page);
      expect(query().where).toEqual({ userId: '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01' });

      mockPrisma.customerProfile.findMany.mockClear();
      await customerService.listProfilesForStaff(officer, { kycStatus: 'PENDING' as any, q: 'smith' }, page);
      expect(query().where).toEqual({
        kycStatus: 'PENDING',
        OR: [{ fullName: { contains: 'smith', mode: 'insensitive' } }, { phoneNumber: { contains: 'smith' } }],
      });
    });

    it('every returned profile is a recorded staff read (one createMany); nothing returned, nothing recorded', async () => {
      mockPrisma.customerProfile.findMany.mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-2' }]);
      const profiles = await customerService.listProfilesForStaff(officer, {}, page);
      expect(profiles).toEqual([{ userId: 'u-1' }, { userId: 'u-2' }]);
      expect(mockPrisma.staffAccessLog.createMany).toHaveBeenCalledWith({
        data: [
          { actorId: 'kyc-1', actorRole: 'KYC_OFFICER', userId: 'u-1', action: 'LIST_CUSTOMERS' },
          { actorId: 'kyc-1', actorRole: 'KYC_OFFICER', userId: 'u-2', action: 'LIST_CUSTOMERS' },
        ],
      });

      mockPrisma.staffAccessLog.createMany.mockClear();
      mockPrisma.customerProfile.findMany.mockResolvedValue([]);
      await customerService.listProfilesForStaff(officer, {}, page);
      expect(mockPrisma.staffAccessLog.createMany).not.toHaveBeenCalled();
    });

    it('NO READ WITHOUT A LOG: if the access log cannot be written, nothing is returned', async () => {
      mockPrisma.customerProfile.findMany.mockResolvedValue([{ userId: 'u-1' }]);
      mockPrisma.staffAccessLog.createMany.mockRejectedValue(new Error('db down'));
      await expect(customerService.listProfilesForStaff(officer, {}, page)).rejects.toThrow('db down');
    });
  });
});
