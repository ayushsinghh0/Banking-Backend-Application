import crypto from 'crypto';
import { PrismaClient, Role } from '../../generated/client';
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
  EventPublisher,
  logger,
} from '@banksphere/common';
import { PasswordService } from './password.service';
import { TokenService, GeneratedTokens } from './token.service';

export interface RegisterDTO {
  email: string;
  password: string;
  role?: Role;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
}

export interface AuthResponse {
  user: PublicUser;
  tokens: GeneratedTokens;
}

export class AuthService {
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokenService: TokenService,
    private readonly eventPublisher?: EventPublisher | null
  ) {}

  /**
   * Registers a new user with Argon2id password hash.
   * Public self-registration always creates a CUSTOMER; elevated roles can only be
   * granted through createStaffUser(), which is restricted to BANK_ADMIN callers.
   */
  public async register(dto: RegisterDTO): Promise<AuthResponse> {
    const user = await this.createUser(dto.email, dto.password, Role.CUSTOMER);
    const tokens = await this.issueTokenPair(user.id, user.email, user.role);
    return { user, tokens };
  }

  /**
   * Creates a user with an explicit role. Only reachable from admin-guarded routes
   * and the bootstrap script.
   */
  public async createStaffUser(dto: Required<RegisterDTO>): Promise<PublicUser> {
    return this.createUser(dto.email, dto.password, dto.role);
  }

  private async createUser(rawEmail: string, password: string, role: Role): Promise<PublicUser> {
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const passwordHash = await PasswordService.hash(password);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, role },
    });

    await this.publishUserRegistered(user.id, user.email, user.role);

    return { id: user.id, email: user.email, role: user.role };
  }

  /**
   * Authenticates user credentials and starts a new token family
   */
  public async login(dto: LoginDTO): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });

    // Always run one Argon2 verification so response time doesn't reveal whether the email exists
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const isPasswordValid = await PasswordService.verify(hashToCheck, dto.password);

    if (!user || !user.isActive || !isPasswordValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const tokens = await this.issueTokenPair(user.id, user.email, user.role);

    return {
      user: { id: user.id, email: user.email, role: user.role },
      tokens,
    };
  }

  /**
   * Rotates refresh token with REUSE DETECTION to defend against token theft
   */
  public async refreshToken(rawRefreshToken: string): Promise<GeneratedTokens> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // TOKEN REUSE ATTACK DETECTION:
    // If an already-revoked refresh token is presented again, someone stole it!
    if (record.isRevoked) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError(
        'Security Alert: Compromised refresh token detected. All active sessions have been terminated. Please log in again.'
      );
    }

    if (new Date() > record.expiresAt) {
      throw new UnauthorizedError('Refresh token has expired. Please log in again.');
    }

    if (!record.user.isActive) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError('Account is disabled');
    }

    // Revoke the presented token with a compare-and-set so that two concurrent refreshes
    // with the same token cannot both succeed: only one update can flip isRevoked false -> true.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, isRevoked: false },
      data: { isRevoked: true },
    });

    if (revoked.count !== 1) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError(
        'Security Alert: Compromised refresh token detected. All active sessions have been terminated. Please log in again.'
      );
    }

    return this.createTokensInFamily(
      record.user.id,
      record.user.email,
      record.user.role,
      record.familyId
    );
  }

  /**
   * Logs out user by revoking the refresh token family
   */
  public async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (record) {
      await this.revokeFamily(record.familyId);
    }
  }

  public async getUser(userId: string): Promise<PublicUser & { isActive: boolean; createdAt: Date }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }

  /**
   * Enables or disables a user. Disabling also revokes every refresh token so
   * existing sessions end once their short-lived access token expires.
   */
  public async setUserActive(userId: string, isActive: boolean): Promise<PublicUser & { isActive: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { isActive } }),
      ...(isActive
        ? []
        : [
            this.prisma.refreshToken.updateMany({
              where: { userId, isRevoked: false },
              data: { isRevoked: true },
            }),
          ]),
    ]);

    return { id: updated.id, email: updated.email, role: updated.role, isActive: updated.isActive };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId },
      data: { isRevoked: true },
    });
  }

  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = PasswordService.hash(crypto.randomBytes(32).toString('hex'));
    }
    return this.dummyHashPromise;
  }

  private async publishUserRegistered(userId: string, email: string, role: Role): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      await this.eventPublisher.publish('user.registered.v1', userId, {
        eventId: crypto.randomUUID(),
        eventType: 'user.registered.v1',
        timestamp: new Date().toISOString(),
        userId,
        email,
        role,
      });
    } catch (err) {
      // Best-effort: the notification directory is not on the critical path of registration
      logger.error({ err, userId }, 'Failed to publish user.registered.v1');
    }
  }

  /**
   * Helper to create a new token pair and token family
   */
  private async issueTokenPair(userId: string, email: string, role: Role): Promise<GeneratedTokens> {
    return this.createTokensInFamily(userId, email, role, crypto.randomUUID());
  }

  private async createTokensInFamily(
    userId: string,
    email: string,
    role: Role,
    familyId: string
  ): Promise<GeneratedTokens> {
    const accessToken = this.tokenService.generateAccessToken({ userId, email, role });
    const rawRefreshToken = this.tokenService.generateRawRefreshToken();
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + this.tokenService.refreshTokenTtlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresInSeconds: this.tokenService.accessTokenTtlSeconds,
    };
  }
}
