process.env.JWT_ACCESS_SECRET = 'test_secret_that_is_definitely_longer_than_32_chars';

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { AuthService } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { TokenService } from '../src/services/token.service';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { createApp } from '../src/app';
import {
  ConsoleMailer,
  InMemoryTokenStateStore,
  UnauthorizedError,
  RateLimitExceededError,
  HttpError,
  createAuthenticate,
  errorHandlerMiddleware,
  verifyAccessToken,
  signAccessToken,
} from '@banksphere/common';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const tokenFromEmail = (text: string) => decodeURIComponent(/#token=([A-Za-z0-9_%-]+)/.exec(text)![1]);

function buildMockPrisma() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
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
    outboxEvent: { create: jest.fn() },
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
      config: { appBaseUrl: 'https://app.example.com', passwordResetTtlMinutes: 30, emailVerificationTtlHours: 24 },
    });
  });

  describe('register', () => {
    it('creates an unverified CUSTOMER, stages user.registered.v1 and emails a verification link', async () => {
      prisma.user.create.mockImplementation(({ data }: any) => activeUser({ ...data, isEmailVerified: false }));

      const result = await authService.register({ email: 'Alice@Bank.com', password: 'Password1234' });
      await authService.drainBackgroundTasks();

      expect(result).not.toHaveProperty('tokens');
      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data).toEqual(expect.objectContaining({ email: 'alice@bank.com', role: 'CUSTOMER' }));
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      expect(prisma.outboxEvent.create.mock.calls[0][0].data.eventType).toBe('user.registered.v1');

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe('alice@bank.com');
      const raw = tokenFromEmail(mailer.sent[0].text);
      // Only the hash is persisted
      expect(prisma.emailVerificationToken.create.mock.calls[0][0].data.tokenHash).toBe(sha256(raw));
      expect(mailer.sent[0].text).toContain('https://app.example.com/verify-email#token=');
    });

    it('PRIVILEGE ESCALATION: always creates CUSTOMER even if a role is supplied', async () => {
      prisma.user.create.mockImplementation(({ data }: any) => activeUser(data));
      await authService.register({ email: 'm@bank.com', password: 'Password1234', role: 'BANK_ADMIN' as any });
      expect(prisma.user.create.mock.calls[0][0].data.role).toBe('CUSTOMER');
    });

    it('ENUMERATION: an existing email gets the same response, and a notice instead of a new account', async () => {
      prisma.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

      const result = await authService.register({ email: 'alice@bank.com', password: 'Password1234' });
      await authService.drainBackgroundTasks();

      expect(result.message).toMatch(/Registration received/);
      expect(mailer.sent[0].subject).toMatch(/Sign-up attempt/);
      expect(mailer.sent[0].text).not.toMatch(/token=/);
    });
  });

  describe('verifyEmail', () => {
    it('marks the user verified with a valid single-use token', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
      });
      await authService.verifyEmail('raw-token-value-123456789');
      expect(prisma.emailVerificationToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256('raw-token-value-123456789') },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { isEmailVerified: true } });
    });

    it('rejects expired, used, or concurrently-consumed tokens', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValueOnce({
        id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() - 1),
      });
      await expect(authService.verifyEmail('x'.repeat(30))).rejects.toThrow(HttpError);

      prisma.emailVerificationToken.findUnique.mockResolvedValueOnce({
        id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      prisma.emailVerificationToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(authService.verifyEmail('x'.repeat(30))).rejects.toThrow('invalid or has expired');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('issues tokens carrying the user token version', async () => {
      prisma.user.findUnique.mockResolvedValue(
        activeUser({ passwordHash: await PasswordService.hash('Password1234'), tokenVersion: 3 })
      );
      const result = await authService.login({ email: 'alice@bank.com', password: 'Password1234' });
      expect(verifyAccessToken(result.tokens.accessToken).tokenVersion).toBe(3);
    });

    it('USER ENUMERATION: performs an Argon2 verification even when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const verifySpy = jest.spyOn(PasswordService, 'verify');
      await expect(authService.login({ email: 'nobody@bank.com', password: 'Whatever123' })).rejects.toThrow(
        'Invalid email or password'
      );
      expect(verifySpy).toHaveBeenCalledTimes(1);
      verifySpy.mockRestore();
    });

    it('refuses unverified emails, but only after a correct password', async () => {
      const hash = await PasswordService.hash('Password1234');
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: hash, isEmailVerified: false }));
      await expect(authService.login({ email: 'alice@bank.com', password: 'Wrong1234567' })).rejects.toThrow(
        UnauthorizedError
      );
      await expect(authService.login({ email: 'alice@bank.com', password: 'Password1234' })).rejects.toThrow(
        'verify your email'
      );
    });

    it('LOCKOUT: locks the account after 5 failures, even for the right password', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: await PasswordService.hash('Password1234') }));
      for (let i = 0; i < 5; i++) {
        await expect(authService.login({ email: 'alice@bank.com', password: `Wrong${i}xxxxx` })).rejects.toThrow(
          UnauthorizedError
        );
      }
      await expect(authService.login({ email: 'alice@bank.com', password: 'Password1234' })).rejects.toThrow(
        RateLimitExceededError
      );
    });
  });

  describe('refreshToken', () => {
    const record = (overrides: Partial<any> = {}) => ({
      id: 'rt1',
      userId: 'u1',
      familyId: 'fam-1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000000),
      user: activeUser(),
      ...overrides,
    });

    it('rotates within the same family', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record());
      await authService.refreshToken('valid');
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt1', isRevoked: false },
        data: { isRevoked: true },
      });
      expect(prisma.refreshToken.create.mock.calls[0][0].data.familyId).toBe('fam-1');
    });

    it('REUSE: a revoked token kills the whole family', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ isRevoked: true }));
      await expect(authService.refreshToken('stolen')).rejects.toThrow(UnauthorizedError);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'fam-1' }, data: { isRevoked: true } });
    });

    it('RACE: losing the compare-and-set is treated as reuse', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record());
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(authService.refreshToken('raced')).rejects.toThrow(UnauthorizedError);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('refuses disabled users', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(record({ user: activeUser({ isActive: false }) }));
      await expect(authService.refreshToken('t')).rejects.toThrow('Account is disabled');
    });
  });

  describe('logout', () => {
    it('revokes the refresh family and denylists the presented access token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', userId: 'u1', familyId: 'fam-9' });
      const token = signAccessToken({ sub: 'u1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 0 });
      const claims = verifyAccessToken(token);

      await authService.logout('refresh', claims);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { familyId: 'fam-9' }, data: { isRevoked: true } });
      expect(await tokenState.isAccessTokenRevoked('u1', claims.jti!, 0)).toBe(true);
    });

    it("does not revoke another user's refresh family", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', userId: 'victim', familyId: 'fam-v' });
      const claims = verifyAccessToken(signAccessToken({ sub: 'u1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 0 }));
      await authService.logout('victims-refresh-token', claims);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
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

    it('emails a single-use link and stores only its hash', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      await authService.forgotPassword('alice@bank.com');
      await authService.drainBackgroundTasks();

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].text).toContain('https://app.example.com/reset-password#token=');
      const raw = tokenFromEmail(mailer.sent[0].text);
      expect(prisma.passwordResetToken.create.mock.calls[0][0].data.tokenHash).toBe(sha256(raw));
      // Earlier links are invalidated
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('MAIL BOMBING: caps reset emails per address per hour', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      for (let i = 0; i < 6; i++) await authService.forgotPassword('alice@bank.com');
      await authService.drainBackgroundTasks();
      expect(mailer.sent).toHaveLength(3);
    });

    it('reset sets the password, bumps the token version, revokes refresh tokens and notifies', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'pr1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        user: activeUser(),
      });
      prisma.user.update.mockImplementation(({ data }: any) =>
        activeUser({ tokenVersion: 1, passwordChangedAt: data.passwordChangedAt })
      );

      await authService.resetPassword('a'.repeat(43), 'NewPassword123');
      await authService.drainBackgroundTasks();

      const update = prisma.user.update.mock.calls[0][0].data;
      expect(update.passwordHash).toMatch(/^\$argon2id\$/);
      expect(update.tokenVersion).toEqual({ increment: 1 });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isRevoked: false },
        data: { isRevoked: true },
      });
      // Old access tokens (version 0) are now revoked
      expect(await tokenState.isAccessTokenRevoked('u1', 'any-jti', 0)).toBe(true);
      expect(await tokenState.isAccessTokenRevoked('u1', 'any-jti', 1)).toBe(false);
      expect(mailer.sent[0].subject).toMatch(/password was changed/);
    });

    it('rejects an expired or already-used reset token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'pr1', userId: 'u1', usedAt: new Date(), expiresAt: new Date(Date.now() + 60000), user: activeUser(),
      });
      await expect(authService.resetPassword('a'.repeat(43), 'NewPassword123')).rejects.toThrow('invalid or has expired');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('requires the current password and rejects reuse', async () => {
      const hash = await PasswordService.hash('Password1234');
      prisma.user.findUnique.mockResolvedValue(activeUser({ passwordHash: hash }));
      const actor = { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER' as const };

      await expect(authService.changePassword(actor, 'WrongPass1234', 'NewPassword123')).rejects.toThrow(
        'Current password is incorrect'
      );
      await expect(authService.changePassword(actor, 'Password1234', 'Password1234')).rejects.toThrow(
        'must be different'
      );
    });
  });

  describe('setUserActive', () => {
    it('disabling bumps the token version so existing access tokens die immediately', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      prisma.user.update.mockResolvedValue(activeUser({ isActive: false, tokenVersion: 1 }));
      await authService.setUserActive('u1', false);
      expect(await tokenState.isAccessTokenRevoked('u1', 'jti', 0)).toBe(true);
    });
  });
});

describe('JWT hardening', () => {
  it('issues HS256 tokens with jti and token version that verify round-trip', () => {
    const token = new TokenService().generateAccessToken({ userId: 'u-1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 2 });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    const claims = verifyAccessToken(token);
    expect(claims).toEqual(expect.objectContaining({ id: 'u-1', role: 'CUSTOMER', tokenVersion: 2 }));
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects alg=none tokens', () => {
    const unsigned =
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN', tv: 0, jti: 'x' })).toString('base64url') +
      '.';
    expect(() => verifyAccessToken(unsigned)).toThrow(UnauthorizedError);
  });

  it('rejects tokens signed with a different secret', () => {
    const original = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'another_secret_that_is_also_longer_than_32_chars';
    const forged = signAccessToken({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN', tokenVersion: 0 });
    process.env.JWT_ACCESS_SECRET = original;
    expect(() => verifyAccessToken(forged)).toThrow(UnauthorizedError);
  });
});

describe('createAuthenticate (revocation)', () => {
  const build = (store: any) => {
    const app = express();
    app.get('/x', createAuthenticate(store), (_req, res) => res.json({ ok: true }));
    app.use(errorHandlerMiddleware);
    return app;
  };

  it('rejects a logged-out (denylisted) token and a token from before a password change', async () => {
    const store = new InMemoryTokenStateStore();
    const app = build(store);
    const token = signAccessToken({ sub: 'u1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 0 });

    expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await store.setTokenVersion('u1', 1);
    expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('FAIL CLOSED: refuses requests with 503 when the token store is unavailable', async () => {
    const app = build({ isAccessTokenRevoked: () => Promise.reject(new Error('redis down')) });
    const token = signAccessToken({ sub: 'u1', email: 'a@b.com', role: 'CUSTOMER', tokenVersion: 0 });
    expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(503);
  });
});

describe('Auth HTTP routes', () => {
  const app = createApp(buildMockPrisma(), {
    tokenState: new InMemoryTokenStateStore(),
    security: new InMemoryAuthSecurityStore(),
    mailer: new ConsoleMailer(),
  }).app;

  it('rejects a registration payload that tries to set a role', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'mallory@bank.com', password: 'Password1234', role: 'BANK_ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires BANK_ADMIN to create staff users', async () => {
    const customerToken = signAccessToken({ sub: 'u-1', email: 'c@b.com', role: 'CUSTOMER', tokenVersion: 0 });
    const res = await request(app)
      .post('/api/v1/auth/admin/users')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ email: 'x@b.com', password: 'Password1234', role: 'BANK_ADMIN' });
    expect(res.status).toBe(403);
  });

  it('forgot-password answers 202 regardless of the address', async () => {
    const res = await request(app).post('/api/v1/auth/password/forgot').send({ email: 'whoever@bank.com' });
    expect(res.status).toBe(202);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/auth/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
