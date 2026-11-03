import crypto from 'crypto';
import Redis from 'ioredis';
import { ConsoleMailer, InMemoryTokenStateStore, generateJwtKeyPair, parseCidrs } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { AuthService, LoginContext } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { TokenService } from '../src/services/token.service';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { RedisEdgeSecurityStore } from '../src/services/edge-security.store';
import { parseCidrList } from '../src/services/ip-address';
import { FakePrisma } from './support/fake-prisma';
import { FakeRedis } from './support/fake-redis';

const ALICE = '4b1d2c3e-5f60-4718-8a9b-0c1d2e3f4a5b';
const ATTACKER: LoginContext = { network: '203.0.113.7', ip: '203.0.113.7', userAgent: 'python-requests/2.32' };
const MINUTE = 60_000;

describe('credential stuffing (design section 9)', () => {
  let clock: number;
  let prisma: FakePrisma;
  let redis: FakeRedis;
  let service: AuthService;
  let verify: jest.SpyInstance;

  beforeEach(() => {
    clock = Date.parse('2026-10-31T10:00:00.000Z');
    const now = () => clock;
    prisma = new FakePrisma();
    redis = new FakeRedis(now);
    service = new AuthService({
      prisma: prisma as unknown as PrismaClient,
      tokenService: new TokenService(),
      tokenState: new InMemoryTokenStateStore(),
      security: new InMemoryAuthSecurityStore(),
      mailer: new ConsoleMailer(),
      edge: new RedisEdgeSecurityStore(redis as unknown as Redis, now),
      config: {
        appBaseUrl: 'https://app.example.com',
        passwordResetTtlMinutes: 30,
        emailVerificationTtlHours: 24,
        sessionMaxDays: 30,
        mfaChallengeTtlSeconds: 300,
        enrolmentTtlHours: 24,
        staffEmailDomain: 'bank.com',
        staffNetworks: parseCidrs('10.20.0.0/16'),
        staffCidrs: parseCidrList('10.20.0.0/16'),
        credentialStuffingThreshold: 20,
        credentialStuffingBanMinutes: 30,
      },
    });
    // Every password is wrong (the sprays below would otherwise run dozens of Argon2id verifications)
    verify = jest.spyOn(PasswordService, 'verify').mockResolvedValue(false);
  });

  afterEach(() => verify.mockRestore());

  /** One failed sign-in, with its after-the-response bookkeeping finished */
  const fail = async (email: string, ctx: LoginContext = ATTACKER) => {
    await expect(service.login({ email, password: 'Wrong-password-1' }, ctx)).rejects.toMatchObject({ statusCode: 401 });
    await service.drainBackgroundTasks();
  };
  const spray = async (from: number, to: number, ctx: LoginContext = ATTACKER) => {
    for (let i = from; i <= to; i++) await fail(`victim${i}@example.com`, ctx);
  };
  const bans = () => redis.keys().filter((k) => k.startsWith('edge:ban:'));
  const banEvents = () => prisma.tables.securityEvent.filter((e) => e.type === 'IP_AUTO_BANNED');

  it('bans the address at the edge for 30 minutes once more than 20 distinct accounts failed from it, and records it once', async () => {
    await spray(1, 20);
    expect(bans()).toEqual([]);
    // The same twenty again: still twenty distinct accounts
    await spray(1, 20);
    expect(bans()).toEqual([]);

    await spray(21, 21);
    expect(bans()).toEqual(['edge:ban:203.0.113.7']);
    expect(JSON.parse((await redis.get('edge:ban:203.0.113.7'))!)).toEqual({ reason: 'CREDENTIAL_STUFFING', bannedAt: expect.any(String), source: 'auth-service', distinctAccounts: 21 });
    expect(await redis.pttl('edge:ban:203.0.113.7')).toBe(30 * MINUTE);
    expect(banEvents()).toEqual([
      expect.objectContaining({ userId: null, ip: '203.0.113.7', deviceLabel: null, details: { reason: 'CREDENTIAL_STUFFING', distinctAccounts: 21, banMinutes: 30 } }),
    ]);
    expect(prisma.tables.auditLog).toEqual([expect.objectContaining({ actorId: null, action: 'IP_AUTO_BANNED', targetId: '203.0.113.7', details: { reason: 'CREDENTIAL_STUFFING', distinctAccounts: 21, banMinutes: 30 }, hash: expect.any(String) })]);

    // Failures while banned neither extend the ban nor record it again
    clock += MINUTE;
    await spray(22, 25);
    expect(await redis.pttl('edge:ban:203.0.113.7')).toBe(29 * MINUTE);
    expect(banEvents()).toHaveLength(1);
    expect(prisma.tables.auditLog).toHaveLength(1);
  });

  it('counts distinct accounts, not attempts: many failures on a few accounts are a lockout matter, not stuffing', async () => {
    for (let round = 0; round < 3; round++) await spray(1, 7);
    expect(bans()).toEqual([]);
  });

  it('uses a sliding 10-minute window: failures older than that no longer count', async () => {
    await spray(1, 15);
    clock += 11 * MINUTE;
    await spray(16, 25); // 10 in the window, 25 overall
    expect(bans()).toEqual([]);
    await spray(26, 36); // 21 in the window
    expect(bans()).toEqual(['edge:ban:203.0.113.7']);
    expect(JSON.parse((await redis.get('edge:ban:203.0.113.7'))!).distinctAccounts).toBe(21);
  });

  it('keys each address separately, IPv6 clients by their /64 (the same key the gateway limits and checks bans by)', async () => {
    const v6: LoginContext = { network: '2001:db8:1:2::/64', ip: '2001:db8:1:2::5' };
    await spray(1, 11);
    await spray(1, 11, v6);
    expect(bans()).toEqual([]);
    await spray(12, 20, v6);
    expect(bans()).toEqual([]);
    await spray(21, 21, v6);
    expect(bans()).toEqual(['edge:ban:2001:db8:1:2::/64']);
    expect(banEvents()).toEqual([expect.objectContaining({ ip: '2001:db8:1:2::5', details: expect.objectContaining({ distinctAccounts: 21 }) })]);
  });

  it('never bans the staff networks or an address it does not know, but still records nothing against the accounts', async () => {
    await spray(1, 30, { network: '10.20.1.2', ip: '10.20.1.2' });
    await spray(1, 30, { network: 'unknown' });
    expect(bans()).toEqual([]);
    expect(banEvents()).toEqual([]);
    expect(prisma.tables.auditLog).toEqual([]);
  });

  it('records a failed sign-in in the account’s history only for accounts that exist, with the reason', async () => {
    prisma.seed('user', [
      { id: ALICE, email: 'alice@example.com', passwordHash: 'argon2-hash', isEmailVerified: true },
      { email: 'dormant@example.com', passwordHash: 'argon2-hash', isEmailVerified: true, isActive: false },
    ]);
    await fail('alice@example.com');
    await fail('nobody@example.com');
    verify.mockResolvedValueOnce(true); // the right password for a disabled account is still a failure
    await fail('dormant@example.com');

    const failures = prisma.tables.securityEvent.filter((e) => e.type === 'SIGN_IN_FAILED');
    expect(failures).toEqual([
      expect.objectContaining({ userId: ALICE, ip: '203.0.113.7', deviceLabel: 'Unknown device', details: { reason: 'INVALID_PASSWORD' } }),
      expect.objectContaining({ userId: expect.any(String), details: { reason: 'ACCOUNT_DISABLED' } }),
    ]);
    // ...while every address tried counts towards the stuffing window
    expect(await redis.pfcount(...redis.keys().filter((k) => k.startsWith('auth:stuffing:203.0.113.7:')))).toBe(3);
  });
});
