import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import {
  ConsoleMailer,
  InMemoryTokenStateStore,
  UnauthorizedError,
  RateLimitExceededError,
  ForbiddenError,
  HttpError,
  createAuthenticate,
  errorHandlerMiddleware,
  generateJwtKeyPair,
  verifyAccessToken,
  signAccessToken,
} from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { AuthService } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { TokenService } from '../src/services/token.service';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { AdminRequestService } from '../src/services/admin-requests.service';
import { encryptSecret, generateTotpSecret, totpAt, currentStep, verifyTotp, base32Decode } from '../src/services/totp';
import { createApp } from '../src/app';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const tokenFromEmail = (text: string) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(text)![1]);
const NET = { network: '203.0.113.7' };

function buildMockPrisma() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      // Session creation re-reads the user under its row lock; by default that sees the same row
      findUniqueOrThrow: jest.fn((args: any) => prisma.user.findUnique(args)),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    refreshToken: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    enrolmentToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    adminRequest: {
      create: jest.fn(({ data }: any) => ({ id: 'req-1', status: 'PENDING', ...data })),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }: any) => ({ id: 'req-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
  };
  prisma.$transaction = jest.fn((arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
  return prisma;
}

const activeUser = (overrides: Partial<any> = {}) => ({
  id: 'u1',
  email: 'alice@bank.com',
  role: 'CUSTOMER',
  isActive: true,
  isEmailVerified: true,
  tokenVersion: 0,
  passwordChangedAt: null,
  mfaEnabled: false,
  mfaSecretEnc: null,
  mfaPendingSecretEnc: null,
  mfaLastUsedStep: null,
  ...overrides,
});

describe('AuthService', () => {
  let prisma: any;
  let mailer: ConsoleMailer;
  let tokenState: InMemoryTokenStateStore;
  let security: InMemoryAuthSecurityStore;
  let authService: AuthService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    mailer = new ConsoleMailer();
    tokenState = new InMemoryTokenStateStore();
    security = new InMemoryAuthSecurityStore();
    authService = new AuthService({
      prisma,
      tokenService: new TokenService(),
      tokenState,
      security,
      mailer,
      config: {
        appBaseUrl: 'https://app.example.com',
        passwordResetTtlMinutes: 30,
        emailVerificationTtlHours: 24,
        sessionMaxDays: 30,
        mfaChallengeTtlSeconds: 300,
        enrolmentTtlHours: 24,
        staffEmailDomain: 'bank.com',
      },
    });
  });

  describe('register', () => {
    it('creates an unverified CUSTOMER, stages user.registered.v1, audits and emails a verification link', async () => {
      prisma.user.create.mockImplementation(({ data }: any) => activeUser({ ...data, isEmailVerified: false }));

      const result = await authService.register({ email: 'Alice@Bank.com', password: 'Password1234' });
      await authService.drainBackgroundTasks();

      expect(result).not.toHaveProperty('tokens');
      expect(prisma.user.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ email: 'alice@bank.com', role: 'CUSTOMER' }));
      expect(prisma.outboxEvent.create.mock.calls[0][0].data.eventType).toBe('user.registered.v1');
      expect(prisma.auditLog.create).toHaveBeenCalled();
      const raw = tokenFromEmail(mailer.sent[0].text);
      expect(prisma.emailVerificationToken.create.mock.calls[0][0].data.tokenHash).toBe(sha256(raw));
    });

    it('PRIVILEGE ESCALATION: always creates CUSTOMER even if a role is supplied', async () => {
      prisma.user.create.mockImplementation(({ data }: any) => activeUser(data));
      await authService.register({ email: 'm@bank.com', password: 'Password1234', role: 'BANK_ADMIN' } as any);
      expect(prisma.user.create.mock.calls[0][0].data.role).toBe('CUSTOMER');
    });

    it('ENUMERATION: an existing email gets the same response and a notice instead of a new account', async () => {
      prisma.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
      const result = await authService.register({ email: 'alice@bank.com', password: 'Password1234' });
      await authService.drainBackgroundTasks();
      expect(result.message).toMatch(/Registration received/);
      expect(mailer.sent[0].subject).toMatch(/Sign-up attempt/);
    });
  });

  describe('verifyEmail', () => {
    it('marks the user verified with a valid single-use token', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60000) });
      await authService.verifyEmail('raw-token-value-123456789');
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { isEmailVerified: true } });
    });

    it('rejects a concurrently-consumed token', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60000) });
      prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(authService.verifyEmail('x'.repeat(30))).rejects.toThrow(HttpError);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('issues tokens carrying the token version and mfa=false', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: await PasswordService.hash('Password1234'), tokenVersion: 3 }));
      const result: any = await authService.login({ email: 'alice@bank.com', password: 'Password1234' }, NET);
      const claims = verifyAccessToken(result.tokens.accessToken);
      expect(claims.tokenVersion).toBe(3);
      expect(claims.mfa).toBe(false);
      // Absolute session lifetime is recorded on the refresh token
      expect(prisma.refreshToken.create.mock.calls[0][0].data.familyExpiresAt).toBeInstanceOf(Date);
    });

    it('USER ENUMERATION: performs an Argon2 verification even when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const verifySpy = jest.spyOn(PasswordService, 'verify');
      await expect(authService.login({ email: 'nobody@bank.com', password: 'Whatever123' }, NET)).rejects.toThrow('Invalid email or password');
      expect(verifySpy).toHaveBeenCalledTimes(1);
      verifySpy.mockRestore();
    });

    it('refuses unverified emails, but only after a correct password', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: await PasswordService.hash('Password1234'), isEmailVerified: false }));
      await expect(authService.login({ email: 'alice@bank.com', password: 'Wrong1234567' }, NET)).rejects.toThrow(UnauthorizedError);
      await expect(authService.login({ email: 'alice@bank.com', password: 'Password1234' }, NET)).rejects.toThrow('verify your email');
    });

    it('LOCKOUT: 5 failures lock that network out, even for the right password', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: await PasswordService.hash('Password1234') }));
      for (let i = 0; i < 5; i++) {
        await expect(authService.login({ email: 'alice@bank.com', password: `Wrong${i}xxxxx` }, NET)).rejects.toThrow(UnauthorizedError);
      }
      await expect(authService.login({ email: 'alice@bank.com', password: 'Password1234' }, NET)).rejects.toThrow(RateLimitExceededError);
    });

    it('LOCKOUT DoS: an attacker locking one network does not lock the owner out from theirs', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: await PasswordService.hash('Password1234') }));
      for (let i = 0; i < 6; i++) {
        await authService.login({ email: 'alice@bank.com', password: `Wrong${i}xxxxx` }, { network: 'attacker' }).catch(() => {});
      }
      const result: any = await authService.login({ email: 'alice@bank.com', password: 'Password1234' }, { network: 'owner-home' });
      expect(result.tokens.accessToken).toBeDefined();
    });
  });

  describe('MFA (TOTP)', () => {
    const enrolledUser = (secret: string, overrides: Partial<any> = {}) =>
      activeUser({ mfaEnabled: true, mfaSecretEnc: encryptSecret(secret, 'u1'), ...overrides });

    it('TOTP implementation matches the RFC 6238 test vector', () => {
      // RFC 6238 Appendix B, SHA1, T=59s -> 94287082 (8 digits); our 6-digit code is its last 6 digits
      const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890")
      expect(base32Decode(secret).toString()).toBe('12345678901234567890');
      expect(totpAt(secret, 1)).toBe('287082');
    });

    it('with MFA enrolled, the password alone yields only a challenge; the code completes login with mfa=true', async () => {
      const secret = generateTotpSecret();
      const user = enrolledUser(secret, { passwordHash: await PasswordService.hash('Password1234') });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.user.findUniqueOrThrow.mockResolvedValue(user);

      const step1: any = await authService.login({ email: 'alice@bank.com', password: 'Password1234' }, NET);
      expect(step1.mfaRequired).toBe(true);
      expect(step1.tokens).toBeUndefined();

      const result = await authService.completeMfaLogin(step1.challengeToken, totpAt(secret, currentStep()));
      expect(verifyAccessToken(result.tokens.accessToken).mfa).toBe(true);
    });

    it('REPLAY: a TOTP code can only be used once', async () => {
      const secret = generateTotpSecret();
      prisma.user.findUnique.mockResolvedValue(enrolledUser(secret));
      prisma.user.findUniqueOrThrow.mockResolvedValue(enrolledUser(secret));
      const challenge = await security.createMfaChallenge('u1', 0, 300);
      prisma.user.updateMany.mockResolvedValueOnce({ count: 0 }); // the step was already consumed
      await expect(authService.completeMfaLogin(challenge, totpAt(secret, currentStep()))).rejects.toThrow(UnauthorizedError);
    });

    it('a challenge dies after 5 wrong codes', async () => {
      const secret = generateTotpSecret();
      prisma.user.findUnique.mockResolvedValue(enrolledUser(secret));
      const challenge = await security.createMfaChallenge('u1', 0, 300);
      for (let i = 0; i < 5; i++) {
        await expect(authService.completeMfaLogin(challenge, '000000')).rejects.toThrow(UnauthorizedError);
      }
      // The challenge is gone: even a correct code can no longer use it
      expect(await security.consumeMfaChallengeAttempt(challenge)).toBeNull();
    });

    const customer = { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER' as const, sessionId: 'fam-1' };

    it('enrolment re-authenticates, encrypts the secret, revokes other sessions and upgrades the current one', async () => {
      const passwordHash = await PasswordService.hash('Password1234');
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash }));
      await expect(authService.beginMfaSetup(customer, 'WrongPassword1')).rejects.toThrow(UnauthorizedError);

      const { secret, otpauthUri } = await authService.beginMfaSetup(customer, 'Password1234');
      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      const pendingEnc = prisma.user.update.mock.calls[0][0].data.mfaPendingSecretEnc;
      expect(pendingEnc).not.toContain(secret); // stored encrypted

      const familyExpiresAt = new Date(Date.now() + 86400_000);
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash, mfaPendingSecretEnc: pendingEnc }));
      prisma.user.update.mockImplementation(({ data }: any) => activeUser({ ...data, tokenVersion: 1 }));
      prisma.refreshToken.findFirst.mockResolvedValue({ id: 'rt-current', familyId: 'fam-1', familyExpiresAt });
      const tokens = await authService.enableMfa(customer, totpAt(secret, currentStep()));

      const claims = verifyAccessToken(tokens.accessToken);
      expect(claims.mfa).toBe(true);
      // Same session (family and absolute expiry) rather than a brand-new 30-day one
      expect(claims.sessionId).toBe('fam-1');
      // A fresh TOTP check, on a factor enrolled just now (so it can't yet authorise high-risk actions)
      expect(claims.stepUpAt).toBeDefined();
      expect(Math.abs(claims.mfaSince! - Date.now() / 1000)).toBeLessThan(5);
      expect(prisma.refreshToken.create.mock.calls.at(-1)[0].data).toEqual(expect.objectContaining({ familyId: 'fam-1', familyExpiresAt }));
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'old', tokenVersion: 0 })).toBe(true);
    });

    it('STAFF ENROLMENT: staff need a one-time enrolment token, so a stolen password alone cannot enrol MFA', async () => {
      const passwordHash = await PasswordService.hash('Password1234');
      const teller = { id: 'u1', email: 't@bank.com', role: 'TELLER' as const, sessionId: 'fam-1' };
      prisma.user.findUnique.mockResolvedValue(activeUser({ role: 'TELLER', passwordHash }));
      prisma.enrolmentToken.findUnique.mockResolvedValue(null);
      await expect(authService.beginMfaSetup(teller, 'Password1234')).rejects.toThrow(HttpError);
      await expect(authService.beginMfaSetup(teller, 'Password1234', 'bogus-token')).rejects.toThrow('enrolment token');

      prisma.enrolmentToken.findUnique.mockResolvedValue({
        id: 'e1', userId: 'u1', purpose: 'MFA_ENROL', usedAt: null, expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(authService.beginMfaSetup(teller, 'Password1234', 'raw-enrolment-token')).resolves.toHaveProperty('secret');
      expect(prisma.enrolmentToken.findUnique.mock.calls.at(-1)[0].where.tokenHash).toBe(sha256('raw-enrolment-token'));
    });

    it('staff cannot disable their own MFA; a staff MFA reset needs a four-eyes request', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ role: 'BANK_ADMIN', mfaEnabled: true }));
      await expect(authService.disableMfa({ id: 'u1', email: 'a', role: 'BANK_ADMIN' }, 'x', '123456')).rejects.toThrow(ForbiddenError);
      await expect(authService.adminResetCustomerMfa({ id: 'a2', email: 'b', role: 'BANK_ADMIN' }, 'u1')).rejects.toThrow('four-eyes');
    });

    it('MFA LOCK: repeated wrong codes pause TOTP sign-in for the user across new challenges', async () => {
      const secret = generateTotpSecret();
      prisma.user.findUnique.mockResolvedValue(enrolledUser(secret));
      for (let i = 0; i < 10; i++) {
        const challenge = await security.createMfaChallenge('u1', 0, 300);
        await expect(authService.completeMfaLogin(challenge, '000000')).rejects.toThrow(UnauthorizedError);
      }
      const fresh = await security.createMfaChallenge('u1', 0, 300);
      await expect(authService.completeMfaLogin(fresh, totpAt(secret, currentStep()))).rejects.toThrow('Too many failed verification codes');
    });

    it('MFA login tokens carry a fresh step-up time and the factor enrolment time', async () => {
      const secret = generateTotpSecret();
      const enrolledAt = new Date(Date.now() - 3 * 86400_000);
      const user = enrolledUser(secret, { passwordHash: await PasswordService.hash('Password1234'), mfaEnabledAt: enrolledAt });
      prisma.user.findUnique.mockResolvedValue(user);
      const step1: any = await authService.login({ email: 'alice@bank.com', password: 'Password1234' }, NET);
      const result = await authService.completeMfaLogin(step1.challengeToken, totpAt(secret, currentStep()));
      const claims = verifyAccessToken(result.tokens.accessToken);
      expect(Math.abs(claims.stepUpAt! - Date.now() / 1000)).toBeLessThan(5);
      expect(claims.mfaSince).toBe(Math.floor(enrolledAt.getTime() / 1000));

      // A refreshed token keeps the MFA session but is NOT a recent step-up
      const fam = prisma.refreshToken.create.mock.calls.at(-1)[0].data;
      const record = { id: 'rt1', userId: 'u1', familyId: fam.familyId, isRevoked: false, expiresAt: new Date(Date.now() + 1e6), familyExpiresAt: fam.familyExpiresAt, mfaAuthenticated: true, user };
      prisma.refreshToken.findUnique.mockResolvedValue(record);
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record);
      const refreshed = verifyAccessToken((await authService.refreshToken('x')).accessToken);
      expect(refreshed.mfa).toBe(true);
      expect(refreshed.stepUpAt).toBeUndefined();
    });

    it('STEP-UP: re-verifying TOTP in an MFA session issues a fresh step-up token; wrong codes are counted', async () => {
      const secret = generateTotpSecret();
      prisma.user.findUnique.mockResolvedValue(enrolledUser(secret, { mfaEnabledAt: new Date(Date.now() - 86400_000 * 2) }));
      prisma.refreshToken.findFirst.mockResolvedValue({ id: 'rt1', familyId: 'fam-1' });
      const actor = { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER' as const, mfa: true, sessionId: 'fam-1' };
      await expect(authService.stepUp({ ...actor, mfa: false }, totpAt(secret, currentStep()))).rejects.toMatchObject({ errorCode: 'MFA_REQUIRED' });
      await expect(authService.stepUp(actor, '000000')).rejects.toMatchObject({ errorCode: 'INVALID_MFA_CODE' });
      const { accessToken } = await authService.stepUp(actor, totpAt(secret, currentStep()));
      const claims = verifyAccessToken(accessToken);
      expect(claims.sessionId).toBe('fam-1');
      expect(Math.abs(claims.stepUpAt! - Date.now() / 1000)).toBeLessThan(5);
    });

    it('a password reset kills a half-finished MFA login (the challenge is bound to the token version)', async () => {
      const secret = generateTotpSecret();
      prisma.user.findUnique.mockResolvedValue(enrolledUser(secret, { tokenVersion: 1 })); // reset happened: version 0 -> 1
      const challenge = await security.createMfaChallenge('u1', 0, 300); // issued before the reset
      await expect(authService.completeMfaLogin(challenge, totpAt(secret, currentStep()))).rejects.toThrow(UnauthorizedError);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('verifyTotp tolerates one step of clock drift and rejects malformed codes', () => {
      const secret = generateTotpSecret();
      const now = Date.now();
      expect(verifyTotp(secret, totpAt(secret, currentStep(now) - 1), now)).toBe(currentStep(now) - 1);
      expect(verifyTotp(secret, totpAt(secret, currentStep(now) - 3), now)).toBeNull();
      expect(verifyTotp(secret, '12ab56', now)).toBeNull();
    });
  });

  describe('refreshToken', () => {
    const record = (overrides: Partial<any> = {}) => ({
      id: 'rt1',
      userId: 'u1',
      familyId: 'fam-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000000),
      familyExpiresAt: new Date(Date.now() + 2000000),
      mfaAuthenticated: true,
      user: activeUser(),
      ...overrides,
    });

    it('rotates within the same family under the user row lock, keeping the MFA flag', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record());
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record());
      const tokens = await authService.refreshToken('valid');
      expect(prisma.$queryRaw).toHaveBeenCalled(); // SELECT ... FOR UPDATE
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: 'rt1' }, data: { isRevoked: true, rotatedAt: expect.any(Date) } });
      expect(prisma.refreshToken.create.mock.calls[0][0].data.familyId).toBe('fam-1');
      expect(verifyAccessToken(tokens.accessToken).mfa).toBe(true);
    });

    it('REUSE: a revoked token kills the whole family', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ isRevoked: true }));
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record({ isRevoked: true }));
      await expect(authService.refreshToken('stolen')).rejects.toThrow(UnauthorizedError);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'fam-1' }, data: { isRevoked: true } });
      // ...and the session's access tokens die immediately (the thief may already hold one)
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'any', tokenVersion: 0, sessionId: 'fam-1' })).toBe(true);
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'any', tokenVersion: 0, sessionId: 'other-session' })).toBe(false);
    });

    it('CONCURRENT REFRESH: a token rotated seconds ago gets a retryable 409, not a family revocation', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ isRevoked: true, rotatedAt: new Date() }));
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record({ isRevoked: true, rotatedAt: new Date() }));
      await expect(authService.refreshToken('twin-tab')).rejects.toMatchObject({ statusCode: 409 });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('ABSOLUTE LIFETIME: a session past its family expiry cannot be refreshed', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ familyExpiresAt: new Date(Date.now() - 1) }));
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record({ familyExpiresAt: new Date(Date.now() - 1) }));
      await expect(authService.refreshToken('old')).rejects.toThrow('session has expired');
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('refuses disabled users', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ user: activeUser({ isActive: false }) }));
      prisma.refreshToken.findUniqueOrThrow.mockResolvedValue(record({ user: activeUser({ isActive: false }) }));
      await expect(authService.refreshToken('t')).rejects.toThrow('Account is disabled');
    });
  });

  describe('logout', () => {
    it('revokes the refresh family and denylists the presented access token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', userId: 'u1', familyId: 'fam-9' });
      const claims = verifyAccessToken(signAccessToken({ sub: 'u1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 0, mfa: false, sessionId: 'fam-9' }));
      await authService.logout('refresh', claims);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'fam-9' }, data: { isRevoked: true } });
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: claims.jti!, tokenVersion: 0 })).toBe(true);
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'sibling-token', tokenVersion: 0, sessionId: 'fam-9' })).toBe(true);
    });
  });

  describe('forgot / reset password', () => {
    it('ENUMERATION: unknown emails get the same 202 answer and no email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await authService.forgotPassword('ghost@bank.com');
      await authService.drainBackgroundTasks();
      expect(result.message).toMatch(/If the address can receive email/);
      expect(mailer.sent).toHaveLength(0);
    });

    it('MAIL BOMBING: caps reset emails per address per hour', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      for (let i = 0; i < 6; i++) await authService.forgotPassword('alice@bank.com');
      await authService.drainBackgroundTasks();
      expect(mailer.sent).toHaveLength(3);
    });

    it('reset sets the password under the user lock, bumps the version, revokes sessions, audits and notifies', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({ id: 'pr1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60000), user: activeUser() });
      prisma.user.update.mockImplementation(({ data }: any) => activeUser({ tokenVersion: 1, passwordChangedAt: data.passwordChangedAt }));

      await authService.resetPassword('a'.repeat(43), 'NewPassword123');
      await authService.drainBackgroundTasks();

      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
      expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('PASSWORD_RESET');
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'any-jti', tokenVersion: 0 })).toBe(true);
      expect(mailer.sent[0].subject).toMatch(/password was changed/);
    });
  });

  describe('administration', () => {
    const admin = { id: 'admin-1', email: 'admin@bank.com', role: 'BANK_ADMIN' as const, mfa: true };
    const admin2 = { id: 'admin-2', email: 'admin2@bank.com', role: 'BANK_ADMIN' as const, mfa: true };

    it('disabling a customer bumps the token version (immediate lock-out) and is audited', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      prisma.user.update.mockResolvedValue(activeUser({ isActive: false, tokenVersion: 1 }));
      await authService.setCustomerActive(admin, 'u1', false);
      expect(await tokenState.isAccessTokenRevoked({ userId: 'u1', jti: 'jti', tokenVersion: 0 })).toBe(true);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ actorId: 'admin-1', action: 'USER_DISABLED' }));
    });

    it('DUAL CONTROL: the admin who disabled a customer cannot re-enable them; another admin can', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ isActive: false }));
      prisma.user.update.mockResolvedValue(activeUser({ isActive: true }));
      prisma.auditLog.findFirst.mockResolvedValue({ actorId: 'admin-1', action: 'USER_DISABLED' });
      await expect(authService.setCustomerActive(admin, 'u1', true)).rejects.toThrow(ForbiddenError);
      await expect(authService.setCustomerActive(admin2, 'u1', true)).resolves.toEqual(expect.objectContaining({ isActive: true }));
    });

    it('resetting a customer MFA is a four-eyes request too (it reopens password-only access)', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ mfaEnabled: true }));
      await expect(authService.adminResetCustomerMfa(admin, 'u1')).rejects.toMatchObject({ errorCode: 'APPROVAL_REQUIRED' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('BOOTSTRAP: only the first two administrators can be created by the bootstrap script', async () => {
      prisma.user.count.mockResolvedValue(2);
      await expect(authService.createBootstrapAdmin('third@bank.com', 'Password12345')).rejects.toThrow('first two administrators');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('administrators cannot disable themselves; staff accounts need an approval request', async () => {
      await expect(authService.setCustomerActive(admin, 'admin-1', false)).rejects.toThrow(ForbiddenError);
      prisma.user.findUnique.mockResolvedValue(activeUser({ role: 'TELLER' }));
      await expect(authService.setCustomerActive(admin, 'u1', false)).rejects.toMatchObject({ errorCode: 'APPROVAL_REQUIRED' });
    });

    describe('four-eyes admin requests', () => {
      let requests: AdminRequestService;
      const pending = (overrides: Partial<any> = {}) => ({
        id: 'req-1',
        type: 'CREATE_STAFF',
        status: 'PENDING',
        payload: { email: 'new.teller@bank.com', role: 'TELLER' },
        targetUserId: null,
        requestedBy: 'admin-1',
        expiresAt: new Date(Date.now() + 3600_000),
        ...overrides,
      });

      beforeEach(() => {
        requests = new AdminRequestService(prisma, authService);
      });

      it('staff creation is only requested; nothing is created until a second admin approves', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        const created = await requests.request(admin, { type: 'CREATE_STAFF', email: 'New.Teller@bank.com', role: 'TELLER' as any });
        expect(created.status).toBe('PENDING');
        expect(prisma.adminRequest.create.mock.calls[0][0].data.payload).toEqual({ email: 'new.teller@bank.com', role: 'TELLER' });
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('staff emails must use the bank domain; CUSTOMER is not a staff role', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        await expect(requests.request(admin, { type: 'CREATE_STAFF', email: 'x@gmail.com', role: 'TELLER' as any })).rejects.toThrow('@bank.com');
        await expect(requests.request(admin, { type: 'CREATE_STAFF', email: 'x@bank.com', role: 'CUSTOMER' as any })).rejects.toThrow('staff roles');
      });

      it('SELF-APPROVAL: the requesting admin can never approve, nor can the target of the request', async () => {
        prisma.adminRequest.findUniqueOrThrow.mockResolvedValue(pending());
        await expect(requests.approve(admin, 'req-1')).rejects.toThrow(ForbiddenError);
        prisma.adminRequest.findUniqueOrThrow.mockResolvedValue(pending({ type: 'SET_USER_ACTIVE', targetUserId: 'admin-2', payload: { userId: 'admin-2', isActive: true } }));
        await expect(requests.approve(admin2, 'req-1')).rejects.toThrow(ForbiddenError);
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('approval by a second admin creates the staff user without any password and emails an activation link', async () => {
        prisma.adminRequest.findUniqueOrThrow.mockResolvedValue(pending());
        prisma.user.create.mockImplementation(({ data }: any) => activeUser({ id: 'staff-1', ...data }));
        const { outcome } = await requests.approve(admin2, 'req-1');
        await authService.drainBackgroundTasks();

        expect(outcome).toEqual({ userId: 'staff-1', email: 'new.teller@bank.com', role: 'TELLER' });
        expect(prisma.user.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ role: 'TELLER', createdBy: 'req-1' }));
        expect(prisma.adminRequest.update.mock.calls.at(-1)[0].data).toEqual(expect.objectContaining({ status: 'APPROVED', decidedBy: 'admin-2' }));
        const raw = tokenFromEmail(mailer.sent[0].text);
        expect(prisma.enrolmentToken.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ purpose: 'ACTIVATE', tokenHash: sha256(raw) }));
      });

      it('expired and already-decided requests cannot be approved', async () => {
        prisma.adminRequest.findUniqueOrThrow.mockResolvedValue(pending({ expiresAt: new Date(Date.now() - 1) }));
        await expect(requests.approve(admin2, 'req-1')).rejects.toThrow('expired');
        prisma.adminRequest.findUniqueOrThrow.mockResolvedValue(pending({ status: 'APPROVED' }));
        await expect(requests.approve(admin2, 'req-1')).rejects.toThrow('already APPROVED');
      });
    });

    it('staff activation sets the chosen password once and returns an MFA enrolment token', async () => {
      prisma.enrolmentToken.findUnique.mockResolvedValue({
        id: 'e1', userId: 'u1', purpose: 'ACTIVATE', usedAt: null, expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.user.update.mockImplementation(({ data }: any) => activeUser({ role: 'TELLER', tokenVersion: 1, passwordHash: data.passwordHash }));
      prisma.user.findUnique.mockResolvedValue(activeUser({ role: 'TELLER', tokenVersion: 1 }));
      const { tokens, enrolmentToken } = await authService.activateStaff('activation-token', 'ChosenPassword1');
      expect(verifyAccessToken(tokens.accessToken).mfa).toBe(false);
      expect(enrolmentToken).toEqual(expect.any(String));
      expect(prisma.enrolmentToken.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'e1', usedAt: null }, data: { usedAt: expect.any(Date) } });

      prisma.enrolmentToken.updateMany.mockResolvedValueOnce({ count: 0 }); // consumed concurrently
      await expect(authService.activateStaff('activation-token', 'ChosenPassword1')).rejects.toThrow('invalid or has expired');
    });
  });
});

describe('JWT (ES256)', () => {
  it('issues ES256 tokens with kid, jti, token version and mfa that verify round-trip', () => {
    const token = new TokenService().generateAccessToken({ userId: 'u-1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 2, mfa: true, sessionId: 'fam-1' });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header).toEqual(expect.objectContaining({ alg: 'ES256', kid: 'test-kid' }));
    expect(verifyAccessToken(token)).toEqual(expect.objectContaining({ id: 'u-1', tokenVersion: 2, mfa: true, sessionId: 'fam-1' }));
  });

  it('rejects alg=none and HS256 tokens (algorithm confusion with the public key)', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN', tv: 0, mfa: true, jti: 'x', exp: 9999999999 })).toString('base64url');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-kid' })).toString('base64url')}.${payload}.`;
    expect(() => verifyAccessToken(none)).toThrow(UnauthorizedError);

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'test-kid' })).toString('base64url');
    const pem = Buffer.from(keys.publicKeyB64, 'base64').toString();
    const sig = crypto.createHmac('sha256', pem).update(`${header}.${payload}`).digest('base64url');
    expect(() => verifyAccessToken(`${header}.${payload}.${sig}`)).toThrow(UnauthorizedError);
  });

  it('rejects tokens signed by a different key', () => {
    const other = generateJwtKeyPair();
    const saved = process.env.JWT_SIGNING_KEY;
    process.env.JWT_SIGNING_KEY = other.privateKeyB64;
    const forged = signAccessToken({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN', tokenVersion: 0, mfa: true, sessionId: 's' });
    process.env.JWT_SIGNING_KEY = saved;
    expect(() => verifyAccessToken(forged)).toThrow(UnauthorizedError);
  });
});

describe('createAuthenticate', () => {
  const build = (store: any, options?: any) => {
    const app = express();
    app.get('/x', createAuthenticate(store, options), (_req, res) => res.json({ ok: true }));
    app.use(errorHandlerMiddleware);
    return app;
  };
  const tokenFor = (role: any, mfa: boolean, tv = 0) => signAccessToken({ sub: 'u1', email: 'a@b.com', role, tokenVersion: tv, mfa, sessionId: 's1' });

  it('rejects a token issued before a password change', async () => {
    const store = new InMemoryTokenStateStore();
    const app = build(store);
    const token = tokenFor('CUSTOMER', false);
    expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await store.setTokenVersion('u1', 1);
    expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('MFA: staff without an MFA session are refused (403 MFA_REQUIRED) except on enrolment routes', async () => {
    const store = new InMemoryTokenStateStore();
    const res = await request(build(store)).get('/x').set('Authorization', `Bearer ${tokenFor('BANK_ADMIN', false)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    expect((await request(build(store)).get('/x').set('Authorization', `Bearer ${tokenFor('BANK_ADMIN', true)}`)).status).toBe(200);
    expect((await request(build(store, { allowStaffWithoutMfa: true })).get('/x').set('Authorization', `Bearer ${tokenFor('SUPPORT', false)}`)).status).toBe(200);
  });

  it('FAIL CLOSED: a Redis outage anywhere in a request is a retryable 503, never a 500', async () => {
    const app = express();
    app.get('/y', () => {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    });
    app.use(errorHandlerMiddleware);
    const res = await request(app).get('/y');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('FAIL CLOSED: 503 when the token store is unavailable', async () => {
    const app = build({ isAccessTokenRevoked: () => Promise.reject(new Error('redis down')) });
    expect((await request(app).get('/x').set('Authorization', `Bearer ${tokenFor('CUSTOMER', false)}`)).status).toBe(503);
  });
});

describe('Auth HTTP routes', () => {
  const app = createApp(buildMockPrisma(), {
    tokenState: new InMemoryTokenStateStore(),
    security: new InMemoryAuthSecurityStore(),
    mailer: new ConsoleMailer(),
  }).app;

  it('rejects a registration payload that tries to set a role', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'mallory@bank.com', password: 'Password1234', role: 'BANK_ADMIN' });
    expect(res.status).toBe(400);
  });

  it('requires BANK_ADMIN with MFA to create staff users', async () => {
    const customer = signAccessToken({ sub: 'u-1', email: 'c@b.com', role: 'CUSTOMER', tokenVersion: 0, mfa: false, sessionId: 's1' });
    const adminNoMfa = signAccessToken({ sub: 'a-1', email: 'a@b.com', role: 'BANK_ADMIN', tokenVersion: 0, mfa: false, sessionId: 's2' });
    const body = { email: 'x@b.com', role: 'TELLER' };
    expect((await request(app).post('/api/v1/auth/admin/users').set('Authorization', `Bearer ${customer}`).send(body)).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/admin/users').set('Authorization', `Bearer ${adminNoMfa}`).send(body)).body.error.code).toBe('MFA_REQUIRED');
  });

  it('staff creation never accepts an administrator-chosen password', async () => {
    const admin = signAccessToken({ sub: 'a-1', email: 'a@b.com', role: 'BANK_ADMIN', tokenVersion: 0, mfa: true, sessionId: 's3' });
    const res = await request(app)
      .post('/api/v1/auth/admin/users')
      .set('Authorization', `Bearer ${admin}`)
      .send({ email: 'x@b.com', role: 'TELLER', password: 'AdminKnowsThis1' });
    expect(res.status).toBe(400);
  });

  it('forgot-password answers 202 regardless of the address', async () => {
    expect((await request(app).post('/api/v1/auth/password/forgot').send({ email: 'whoever@bank.com' })).status).toBe(202);
  });
});
