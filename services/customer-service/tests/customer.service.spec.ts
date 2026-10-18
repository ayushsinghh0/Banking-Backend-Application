import { CustomerService } from '../src/services/customer.service';
import { NotFoundError, ForbiddenError } from '@banksphere/common';

describe('CustomerService (Redis Cache-Aside & Invalidation)', () => {
  let mockPrisma: any;
  let mockRedis: any;
  let customerService: CustomerService;

  beforeEach(() => {
    mockPrisma = {
      customerProfile: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      kycEvent: { create: jest.fn(), findMany: jest.fn() },
    };
    mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));

    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    customerService = new CustomerService(mockPrisma, mockRedis, 1800);
  });

  describe('getProfileByUserId (Cache-Aside Pattern)', () => {
    it('CACHE HIT: should return profile from Redis without hitting PostgreSQL', async () => {
      const cachedProfile = {
        id: 'cp-1',
        userId: 'u-1',
        fullName: 'Alice Smith',
        phoneNumber: '+919876543210',
        kycStatus: 'VERIFIED',
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(cachedProfile));

      const result = await customerService.getProfileByUserId('u-1');

      expect(result.fromCache).toBe(true);
      expect(result.profile.fullName).toBe('Alice Smith');
      // PostgreSQL should NEVER be queried on a cache hit!
      expect(mockPrisma.customerProfile.findUnique).not.toHaveBeenCalled();
    });

    it('CACHE MISS: should query PostgreSQL and populate Redis cache with TTL', async () => {
      mockRedis.get.mockResolvedValue(null); // Cache miss

      const dbProfile = {
        id: 'cp-2',
        userId: 'u-2',
        fullName: 'Bob Jones',
        phoneNumber: '+919876543211',
        kycStatus: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.customerProfile.findUnique.mockResolvedValue(dbProfile);

      const result = await customerService.getProfileByUserId('u-2');

      expect(result.fromCache).toBe(false);
      expect(result.profile.fullName).toBe('Bob Jones');
      expect(mockPrisma.customerProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'u-2' },
      });
      // Redis populated with EX TTL
      expect(mockRedis.set).toHaveBeenCalledWith(
        'customer:profile:u-2',
        JSON.stringify(dbProfile),
        'EX',
        1800
      );
    });

    it('should throw NotFoundError if profile does not exist in DB', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.customerProfile.findUnique.mockResolvedValue(null);

      await expect(customerService.getProfileByUserId('u-unknown')).rejects.toThrow(
        NotFoundError
      );
    });
  });

  describe('updateProfile (Cache Invalidation)', () => {
    it('should update PostgreSQL and immediately purge the Redis cache key', async () => {
      mockPrisma.customerProfile.findUnique.mockResolvedValue({
        id: 'cp-1',
        userId: 'u-1',
        fullName: 'Old Name',
      });

      mockPrisma.customerProfile.update.mockResolvedValue({
        id: 'cp-1',
        userId: 'u-1',
        fullName: 'New Name',
      });

      const updated = await customerService.updateProfile('u-1', { fullName: 'New Name' });

      expect(updated.fullName).toBe('New Name');
      // Verify cache invalidation occurred
      expect(mockRedis.del).toHaveBeenCalledWith('customer:profile:u-1');
    });
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
      const admin = { id: 'admin-1', email: 'a@b.com', role: 'BANK_ADMIN' as const, mfa: true };
      await expect(customerService.updateKycStatus(admin, 'admin-1', 'VERIFIED' as any)).rejects.toThrow(ForbiddenError);

      mockPrisma.customerProfile.findUnique.mockResolvedValue({ userId: 'u-1', kycStatus: 'PENDING' });
      mockPrisma.customerProfile.update.mockResolvedValue({ userId: 'u-1', kycStatus: 'VERIFIED' });
      await customerService.updateKycStatus(admin, 'u-1', 'VERIFIED' as any);
      expect(mockPrisma.kycEvent.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ actorId: 'admin-1', toStatus: 'VERIFIED' }));
    });
  });
});
