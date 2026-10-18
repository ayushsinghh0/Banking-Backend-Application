import { AuthService } from '../src/services/auth.service';
import { PasswordService } from '../src/services/password.service';
import { UnauthorizedError, ConflictError } from '@banksphere/common';

describe('AuthService (Security, Argon2id, and Refresh Token Rotation)', () => {
  let mockPrisma: any;
  let mockTokenService: any;
  let authService: AuthService;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    mockTokenService = {
      generateAccessToken: jest.fn().mockReturnValue('mock.jwt.access.token'),
      generateRawRefreshToken: jest.fn().mockReturnValue('mock-raw-refresh-token-12345'),
      hashRefreshToken: jest.fn((token: string) => `hashed_${token}`),
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
      mockPrisma.user.create.mockResolvedValue({
        id: 'u1',
        email: 'alice@bank.com',
        role: 'CUSTOMER',
      });

      const result = await authService.register({
        email: 'alice@bank.com',
        password: 'Password123',
      });

      expect(result.user.email).toBe('alice@bank.com');
      expect(result.tokens.accessToken).toBe('mock.jwt.access.token');
      expect(mockPrisma.refreshToken.create).toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('should reject invalid passwords without leaking user existence timing', async () => {
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
  });

  describe('refreshToken (Rotation & Reuse Attack Detection)', () => {
    it('should successfully rotate refresh token if token is valid and unrevoked', async () => {
      const futureDate = new Date(Date.now() + 1000000);
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-rec-1',
        tokenHash: 'hashed_valid_token',
        userId: 'u1',
        familyId: 'fam-1',
        isRevoked: false,
        expiresAt: futureDate,
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER' },
      });

      const newTokens = await authService.refreshToken('valid_token');

      // 1. Old token marked as revoked
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-rec-1' },
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
      const futureDate = new Date(Date.now() + 1000000);
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'stolen-token-rec',
        tokenHash: 'hashed_stolen_token',
        userId: 'u1',
        familyId: 'fam-99',
        isRevoked: true, // ALREADY REVOKED! Stolen token replay!
        expiresAt: futureDate,
        user: { id: 'u1', email: 'alice@bank.com', role: 'CUSTOMER' },
      });

      await expect(authService.refreshToken('stolen_token')).rejects.toThrow(
        UnauthorizedError
      );

      // Entire family invalidated!
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'fam-99' },
        data: { isRevoked: true },
      });
    });
  });
});
