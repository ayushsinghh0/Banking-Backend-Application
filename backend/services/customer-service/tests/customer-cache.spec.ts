import { AuthenticatedUser, Cache, HttpError, NotFoundError } from '@banksphere/common';
import { CustomerService } from '../src/services/customer.service';
import { CustomerCache } from '../src/services/customer-cache';
import { KycStatus } from '../generated/client';
import { FakeRedis } from './support/fake-redis';

const ALICE = 'alice-user-id';
const officer: AuthenticatedUser = { id: 'kyc-1', email: 'kyc@bank.com', role: 'KYC_OFFICER', mfa: true };
const support: AuthenticatedUser = { id: 'sup-1', email: 'support@bank.com', role: 'SUPPORT', mfa: true };

const profile = (overrides: Partial<any> = {}) => ({
  id: 'cp-1',
  userId: ALICE,
  fullName: 'Alice Smith',
  phoneNumber: '+919876543210',
  address: null,
  dateOfBirth: new Date('1990-05-17T00:00:00.000Z'),
  kycStatus: KycStatus.PENDING,
  version: 1,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
  ...overrides,
});

/** A one-row customer_profiles table behind a Prisma stand-in, so writes are visible to later reads */
function setup() {
  let stored: any = profile();
  const prisma: any = {
    customerProfile: {
      findUnique: jest.fn(async ({ select }: any) => (stored && select?.kycStatus ? { kycStatus: stored.kycStatus } : stored)),
      findUniqueOrThrow: jest.fn(async () => stored),
      update: jest.fn(async ({ data }: any) => {
        const { version, ...rest } = data;
        stored = { ...stored, ...rest, version: stored.version + (version?.increment ?? 0) };
        return stored;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.version !== undefined && where.version !== stored.version) return { count: 0 };
        stored = { ...stored, kycStatus: data.kycStatus, version: stored.version + 1 };
        return { count: 1 };
      }),
      create: jest.fn(),
    },
    kycEvent: { create: jest.fn() },
    staffAccessLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction = jest.fn((cb: any) => cb(prisma));
  const redis = new FakeRedis();
  const service = new CustomerService(prisma, new CustomerCache(new Cache(redis as any, { namespace: 'customer' })));
  const profileReads = () => prisma.customerProfile.findUnique.mock.calls.filter((c: any[]) => !c[0].select).length;
  const kycReads = () => prisma.customerProfile.findUnique.mock.calls.filter((c: any[]) => c[0].select?.kycStatus).length;
  const version = (tag: 'profile' | 'kyc') => redis.store.get(`cache:customer:ver:${tag}:${ALICE}`);
  const setStored = (next: any) => {
    stored = next;
  };
  return { prisma, redis, service, profileReads, kycReads, version, setStored };
}

describe('Customer profile cache (cache:customer:profile:<userId>, 5 min)', () => {
  it('MISS then HIT; dates survive the cache; the hit is reported for the X-Cache-Lookup header', async () => {
    const { redis, service, profileReads } = setup();
    const first = await service.getProfileByUserId(ALICE);
    const second = await service.getProfileByUserId(ALICE);
    expect([first.fromCache, second.fromCache]).toEqual([false, true]);
    expect(profileReads()).toBe(1);
    expect(second.profile).toEqual(first.profile);
    expect(second.profile.dateOfBirth).toBeInstanceOf(Date);
    expect([...redis.store.keys()]).toEqual([`cache:customer:profile:${ALICE}:v0`]);
  });

  it('a missing profile is a 404 every time and is never cached', async () => {
    const { redis, service, profileReads, setStored } = setup();
    setStored(null);
    await expect(service.getProfileByUserId(ALICE)).rejects.toThrow(NotFoundError);
    await expect(service.getProfileByUserId(ALICE)).rejects.toThrow(NotFoundError);
    expect(profileReads()).toBe(2);
    expect(redis.store.size).toBe(0);
  });

  it('PROFILE UPDATE: a committed phone change invalidates the profile view only; the next read is fresh', async () => {
    const { service, profileReads, kycReads, version } = setup();
    await service.getProfileByUserId(ALICE);
    await service.getKycStatus(ALICE);
    await service.updateProfile(ALICE, { phoneNumber: '+919876500000' });
    expect([version('profile'), version('kyc')]).toEqual(['1', undefined]);

    const next = await service.getProfileByUserId(ALICE);
    expect(next.fromCache).toBe(false);
    expect(next.profile.phoneNumber).toBe('+919876500000');
    expect(profileReads()).toBe(3); // the read, the update's locked read, the fresh read
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    expect(kycReads()).toBe(1); // still served from the cache
  });

  it('IDENTITY CHANGE on a VERIFIED profile resets KYC and invalidates both views, so account-service sees PENDING at once', async () => {
    const { service, version, setStored } = setup();
    setStored(profile({ kycStatus: KycStatus.VERIFIED, version: 3 }));
    expect(await service.getKycStatus(ALICE)).toBe('VERIFIED');
    expect((await service.getProfileByUserId(ALICE)).profile.kycStatus).toBe('VERIFIED');

    await service.updateProfile(ALICE, { fullName: 'Alice Jones' });
    expect([version('profile'), version('kyc')]).toEqual(['1', '1']);
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    const fresh = await service.getProfileByUserId(ALICE);
    expect([fresh.profile.fullName, fresh.profile.kycStatus, fresh.profile.version]).toEqual(['Alice Jones', 'PENDING', 4]);
  });

  it('RACE: a reader that loaded the row before a KYC decision committed cannot leave the old profile in the cache', async () => {
    const { prisma, service } = setup();
    // The reader's database read returns the PENDING row, but the decision commits before the reader fills the cache
    prisma.customerProfile.findUnique.mockImplementationOnce(async () => {
      const pending = profile();
      await service.updateKycStatus(officer, ALICE, KycStatus.VERIFIED, 1);
      return pending;
    });
    expect((await service.getProfileByUserId(ALICE)).profile.kycStatus).toBe('PENDING'); // what it read

    const next = await service.getProfileByUserId(ALICE);
    expect(next.fromCache).toBe(false); // the stale fill landed under the old version, which nobody reads
    expect(next.profile.kycStatus).toBe('VERIFIED');
  });

  it('STAFF reads are never served from the cache and are recorded every time', async () => {
    const { prisma, service, profileReads } = setup();
    await service.getProfileByUserId(ALICE); // warms Alice's own view
    await service.getProfileForStaff(support, ALICE);
    await service.getProfileForStaff(support, ALICE);
    expect(profileReads()).toBe(3);
    expect(prisma.staffAccessLog.create).toHaveBeenCalledTimes(2);
  });

  it('FAIL OPEN: with the cache Redis down, reads come from the database and writes still commit', async () => {
    const { redis, service, profileReads } = setup();
    redis.failing = true;
    expect((await service.getProfileByUserId(ALICE)).fromCache).toBe(false);
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    await service.updateProfile(ALICE, { phoneNumber: '+919876500000' });
    expect((await service.getProfileByUserId(ALICE)).profile.phoneNumber).toBe('+919876500000');
    expect(profileReads()).toBe(3);
  });
});

describe('KYC status cache (cache:customer:kyc:<userId>, 60 s)', () => {
  it('MISS then HIT; a committed decision invalidates the KYC view and the profile view', async () => {
    const { redis, service, kycReads, version } = setup();
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    expect(kycReads()).toBe(1);
    expect(redis.store.has(`cache:customer:kyc:${ALICE}:v0`)).toBe(true);
    await service.getProfileByUserId(ALICE);

    await service.updateKycStatus(officer, ALICE, KycStatus.VERIFIED, 1);
    expect([version('profile'), version('kyc')]).toEqual(['1', '1']);
    expect(await service.getKycStatus(ALICE)).toBe('VERIFIED');
    expect(kycReads()).toBe(2);
    expect((await service.getProfileByUserId(ALICE)).profile.kycStatus).toBe('VERIFIED');
    // One cache path: everything this service caches lives in its own namespace on the cache Redis
    for (const key of redis.store.keys()) expect(key).toMatch(/^cache:customer:/);
  });

  it('a refused decision (the profile changed since it was reviewed) invalidates nothing', async () => {
    const { service, version } = setup();
    await service.getKycStatus(ALICE);
    await expect(service.updateKycStatus(officer, ALICE, KycStatus.VERIFIED, 7)).rejects.toThrow(HttpError);
    expect([version('profile'), version('kyc')]).toEqual([undefined, undefined]);
  });

  it('a user without a profile is PENDING, and creating the profile needs no invalidation (it is PENDING too)', async () => {
    const { prisma, service, kycReads, setStored } = setup();
    setStored(null);
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    prisma.customerProfile.create.mockImplementation(async ({ data }: any) => {
      setStored(profile(data));
      return profile(data);
    });
    await service.createProfile({ userId: ALICE, fullName: 'Alice Smith', phoneNumber: '+919876543210' });
    expect(await service.getKycStatus(ALICE)).toBe('PENDING');
    expect(kycReads()).toBe(1);
  });
});
