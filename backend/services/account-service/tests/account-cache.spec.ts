import { AuthenticatedUser, Cache, HttpError } from '@banksphere/common';
import { AccountService } from '../src/services/account.service';
import { AccountListCache } from '../src/services/account-cache';
import { AccountStatus } from '../generated/client';
import { FakeRedis } from './support/fake-redis';

const alice: AuthenticatedUser = { id: 'alice-cust-id', email: 'alice@bank.com', role: 'CUSTOMER' };
const admin: AuthenticatedUser = { id: 'admin-user-id', email: 'admin@bank.com', role: 'BANK_ADMIN', mfa: true };
const support: AuthenticatedUser = { id: 'support-user-id', email: 'support@bank.com', role: 'SUPPORT', mfa: true };

const account = (overrides: Partial<any> = {}) => ({
  id: 'acc-1',
  accountNumber: '200000000006',
  customerId: 'alice-cust-id',
  accountType: 'SAVINGS',
  status: AccountStatus.ACTIVE,
  currency: 'INR',
  dailyLimit: 10_000_000n,
  bankLimitCeiling: null,
  version: 3,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

function setup() {
  let stored = account();
  const prisma: any = {
    bankAccount: {
      findUnique: jest.fn(async () => stored),
      findUniqueOrThrow: jest.fn(async () => stored),
      findMany: jest.fn(async () => [stored]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async ({ data }: any) => ({ version: 1, bankLimitCeiling: null, ...data, createdAt: new Date(), updatedAt: new Date() })),
      updateMany: jest.fn(async ({ data }: any) => {
        if (data?.version?.increment) stored = { ...stored, version: stored.version + 1 };
        else stored = { ...stored, ...data };
        return { count: 1 };
      }),
    },
    staffAccessLog: { create: jest.fn() },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction = jest.fn((cb: any) => cb(prisma));
  const ledger = {
    provisionAccount: jest.fn(),
    updateAccount: jest.fn().mockResolvedValue({ applied: true }),
    closeAccount: jest.fn(),
    getAccount: jest.fn(),
    getAccounts: jest.fn().mockResolvedValue([]),
  };
  const customers = { getKycStatus: jest.fn().mockResolvedValue('VERIFIED') };
  const redis = new FakeRedis();
  const service = new AccountService(prisma, ledger as any, customers, new AccountListCache(new Cache(redis as any, { namespace: 'account' })));
  const listReads = () => prisma.bankAccount.findMany.mock.calls.length;
  const version = () => redis.store.get('cache:account:ver:cust:alice-cust-id');
  return { prisma, ledger, customers, redis, service, listReads, version };
}

describe('Account list cache (metadata, never balances)', () => {
  it('MISS then HIT under cache:account:list:<customerId>; BigInt limits and dates survive the cache', async () => {
    const { redis, service, listReads } = setup();
    const first = await service.listAccounts(alice);
    const second = await service.listAccounts(alice);
    expect(listReads()).toBe(1);
    expect(second).toEqual(first);
    expect(second[0].dailyLimit).toBe(10_000_000n);
    expect(second[0].createdAt).toBeInstanceOf(Date);
    expect([...redis.store.keys()]).toEqual(['cache:account:list:alice-cust-id:v0']);
    expect(redis.store.get('cache:account:list:alice-cust-id:v0')).not.toContain('balance');
  });

  it('OPEN: a committed new account invalidates the list; a refused opening does not', async () => {
    const { customers, service, listReads, version } = setup();
    await service.listAccounts(alice);
    customers.getKycStatus.mockResolvedValueOnce('PENDING');
    await expect(service.createAccount({ customerId: 'alice-cust-id' }, alice)).rejects.toThrow(HttpError);
    expect(version()).toBeUndefined();
    await service.createAccount({ customerId: 'alice-cust-id' }, alice);
    expect(version()).toBe('1');
    await service.listAccounts(alice);
    expect(listReads()).toBe(2);
  });

  it('STATUS: a freeze invalidates the list after commit, and the next read shows FROZEN', async () => {
    const { service, version } = setup();
    expect((await service.listAccounts(alice))[0].status).toBe('ACTIVE');
    await service.updateAccountStatus('acc-1', AccountStatus.FROZEN, alice);
    expect(Number(version())).toBeGreaterThanOrEqual(1);
    expect((await service.listAccounts(alice))[0].status).toBe('FROZEN');
  });

  it('LIMIT: a limit change invalidates the list; so does a reserved version even if the ledger then refuses', async () => {
    const { ledger, service, version } = setup();
    await service.listAccounts(alice);
    await service.updateDailyLimit('acc-1', 5_000n, alice);
    const afterLimit = Number(version());
    expect(afterLimit).toBeGreaterThanOrEqual(1);
    expect((await service.listAccounts(alice))[0].dailyLimit).toBe(5_000n);

    ledger.updateAccount.mockResolvedValueOnce({ applied: false }); // the ledger holds a newer state
    await expect(service.updateDailyLimit('acc-1', 4_000n, alice)).rejects.toThrow('concurrently');
    expect(Number(version())).toBeGreaterThan(afterLimit); // the version field in the list changed
  });

  it('STAFF: a cached list is still access-logged on every staff read', async () => {
    const { prisma, service, listReads } = setup();
    await service.listAccounts(support, 'alice-cust-id');
    await service.listAccounts(support, 'alice-cust-id');
    expect(listReads()).toBe(1);
    expect(prisma.staffAccessLog.create).toHaveBeenCalledTimes(2);
  });

  it('the list a customer gets is always their own, whatever the cache holds for others', async () => {
    const { prisma, service } = setup();
    await service.listAccounts(support, 'alice-cust-id'); // warms alice's list
    const bob: AuthenticatedUser = { id: 'bob-id', email: 'bob@bank.com', role: 'CUSTOMER' };
    prisma.bankAccount.findMany.mockResolvedValueOnce([]);
    expect(await service.listAccounts(bob, 'alice-cust-id')).toEqual([]);
    expect(prisma.bankAccount.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { customerId: 'bob-id' } }));
  });

  it('FAIL OPEN: with the cache Redis down the list comes from the database', async () => {
    const { redis, service, listReads } = setup();
    redis.failing = true;
    expect(await service.listAccounts(alice)).toHaveLength(1);
    await service.updateAccountStatus('acc-1', AccountStatus.FROZEN, admin);
    expect(listReads()).toBe(1);
  });
});
