process.env.JWT_ACCESS_SECRET = 'test_secret_that_is_definitely_longer_than_32_chars';

import request from 'supertest';
import { AuthService } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { TokenService } from '../src/services/token.service';
import { createApp } from '../src/app';
import { UnauthorizedError, ConflictError, verifyAccessToken, signAccessToken } from '@banksphere/common';

describe('AuthService (Security, Argon2id, and Refresh Token Rotation)', () => {
  let mockPrisma: any;
  let mockTokenService: any;
  let authService: AuthService;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };

    mockTokenService = {
      generateAccessToken: jest.fn().mockReturnValue('mock.jwt.access.token'),
      generateRawRefreshToken: jest.fn().mockReturnValue('mock-raw-refresh-token-12345'),
      hashRefreshToken: jest.fn((token: string) => `hashed_${token}`),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlMs: 7 * 24 * 60 * 60 * 1000,
    };

    authService = new AuthService(mockPrisma, mockTokenService);
  });

  describe('register', () => {
    it('should reject registration if email is already taken', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'alice@bank.com' });

      await expect(
        authService.register({ email: 'alice@bank.com', password: 'Password123' })
      ).rejects.toThrow(ConflictError);
    });

    it('should securely hash password with Argon2id and issue tokens', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(({ data }: any) => ({ id: 'u1', ...data }));

      const result = await authService.register({
        email: 'Alice@Bank.com',
        password: 'Password123',
      });

      expect(result.user.email).toBe('alice@bank.com');
      expect(result.tokens.accessToken).toBe('mock.jwt.access.token');
      expect(mockPrisma.user.create.mock.calls[0][0].data.passwordHash).toMatch(/^\$argon2id\$/);
      expect(mockPrisma.refreshToken.create).toHaveBeenCalled();
    });

    it('PRIVILEGE ESCALATION: always creates CUSTOMER even if a role is supplied', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(({ data }: any) => ({ id: 'u1', ...data }));

      const result = await authService.register({
        email: 'mallory@bank.com',
        password: 'Password123',
        role: 'BANK_ADMIN' as any,
      });

      expect(mockPrisma.user.create.mock.calls[0][0].data.role).toBe('CUSTOMER');
      expect(result.user.role).toBe('CUSTOMER');
    });
  });

  describe('login', () => {
    it('should reject invalid passwords', async () => {
      const realHash = await PasswordService.hash('CorrectPassword123');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'alice@bank.com',
        passwordHash: realHash,
        isActive: true,
      });

      await expect(
        authService.login({ email: 'alice@bank.com', password: 'WrongPassword' })
      ).rejects.toThrow(UnauthorizedError);
    });

    it('USER ENUMERATION: still performs an Argon2 verification when the user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const verifySpy = jest.spyOn(PasswordService, 'verify');

      await expect(
        authService.login({ email: 'nobody@bank.com', password: 'Whatever123' })
      ).rejects.toThrow('Invalid email or password');
      expect(verifySpy).toHaveBeenCalledTimes(1);
      verifySpy.mockRestore();
    });

    it('should reject disabled users with the same generic error', async () => {
      const realHash = await PasswordService.hash('CorrectPassword123');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'alice@bank.com',
        passwordHash: realHash,
        isActive: false,
      });

      await expect(
        authService.login({ email: 'alice@bank.com', password: 'CorrectPassword123' })
      ).rejects.toThrow('Invalid email or password');
    });
  });

  describe('refreshToken (Rotation & Reuse Attack Detection)', () => {
    const futureDate = () => new Date(Date.now() + 1000000);

    it('should successfully rotate refresh token if token is valid and unrevoked', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-1',
        tokenHash: 'hashed_valid_token',
        userId: 'u1',
        familyId: 'fam-1',
        isRevoked: false,
        expiresAt: futureDate(),
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER', isActive: true },
      });

      const newTokens = await authService.refreshToken('valid_token');

      // 1. Old token revoked with a compare-and-set
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'token-rec-1', isRevoked: false },
        data: { isRevoked: true },
      });

      // 2. New token created in the same family
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ familyId: 'fam-1' }),
        })
      );

      expect(newTokens.accessToken).toBe('mock.jwt.access.token');
    });

    it('REUSE ATTACK: should revoke the entire token family if a revoked token is presented', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'stolen-token-rec',
        tokenHash: 'hashed_stolen_token',
        userId: 'u1',
        familyId: 'fam-99',
        isRevoked: true,
        expiresAt: futureDate(),
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER', isActive: true },
      });

      await expect(authService.refreshToken('stolen_token')).rejects.toThrow(UnauthorizedError);

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'fam-99' },
        data: { isRevoked: true },
      });
    });

    it('RACE: a concurrent refresh that loses the compare-and-set is treated as reuse', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-2',
        userId: 'u1',
        familyId: 'fam-2',
        isRevoked: false,
        expiresAt: futureDate(),
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER', isActive: true },
      });
      // Another request already flipped isRevoked
      mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(authService.refreshToken('raced_token')).rejects.toThrow(UnauthorizedError);
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenLastCalledWith({
        where: { familyId: 'fam-2' },
        data: { isRevoked: true },
      });
    });

    it('should refuse to refresh sessions of disabled users', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-3',
        userId: 'u1',
        familyId: 'fam-3',
        isRevoked: false,
        expiresAt: futureDate(),
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER', isActive: false },
      });

      await expect(authService.refreshToken('t')).rejects.toThrow('Account is disabled');
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });
});

describe('TokenService (JWT hardening)', () => {
  it('issues HS256 tokens with subject, issuer and audience that verify round-trip', () => {
    const service = new TokenService();
    const token = service.generateAccessToken({ userId: 'u-1', email: 'a@b.com', role: 'CUSTOMER' });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(verifyAccessToken(token)).toEqual({ id: 'u-1', email: 'a@b.com', role: 'CUSTOMER' });
  });

  it('rejects alg=none tokens', () => {
    const unsigned =
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN' })).toString('base64url') +
      '.';
    expect(() => verifyAccessToken(unsigned)).toThrow(UnauthorizedError);
  });

  it('rejects tokens signed with a different secret', () => {
    const original = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'another_secret_that_is_also_longer_than_32_chars';
    const forged = signAccessToken({ sub: 'u-1', email: 'a@b.com', role: 'BANK_ADMIN' });
    process.env.JWT_ACCESS_SECRET = original;
    expect(() => verifyAccessToken(forged)).toThrow(UnauthorizedError);
  });
});

describe('Auth HTTP routes', () => {
  const app = createApp({} as any).app;

  it('rejects a registration payload that tries to set a role', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'mallory@bank.com', password: 'Password123', role: 'BANK_ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires BANK_ADMIN to create staff users', async () => {
    const customerToken = signAccessToken({ sub: 'u-1', email: 'c@b.com', role: 'CUSTOMER' });
    const res = await request(app)
      .post('/api/v1/auth/admin/users')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ email: 'x@b.com', password: 'Password123', role: 'BANK_ADMIN' });
    expect(res.status).toBe(403);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/auth/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
