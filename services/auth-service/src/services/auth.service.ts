import crypto from 'crypto';
import { Prisma, PrismaClient, Role, User } from '../../generated/client';
import {
  AuthenticatedUser,
  ConflictError,
  HttpError,
  Mailer,
  NotFoundError,
  RateLimitExceededError,
  TokenStateStore,
  UnauthorizedError,
  logger,
} from '@banksphere/common';
import { PasswordService } from './password.service';
import { TokenService, GeneratedTokens } from './token.service';
import { AuthSecurityStore } from './auth-security.store';
import {
  existingAccountEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './auth-emails';

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

export interface AuthServiceConfig {
  appBaseUrl: string;
  passwordResetTtlMinutes: number;
  emailVerificationTtlHours: number;
}

export const defaultAuthServiceConfig = (): AuthServiceConfig => ({
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24),
});

export interface AuthServiceDeps {
  prisma: PrismaClient;
  tokenService: TokenService;
  tokenState: TokenStateStore;
  security: AuthSecurityStore;
  mailer: Mailer;
  config?: AuthServiceConfig;
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const ACCEPTED_MESSAGE =
  'If the address can receive email, a message with further instructions has been sent.';

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
const newOneTimeToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly tokenService: TokenService;
  private readonly tokenState: TokenStateStore;
  private readonly security: AuthSecurityStore;
  private readonly mailer: Mailer;
  private readonly config: AuthServiceConfig;
  private dummyHashPromise: Promise<string> | null = null;
  private readonly background = new Set<Promise<void>>();

  constructor(deps: AuthServiceDeps) {
    this.prisma = deps.prisma;
    this.tokenService = deps.tokenService;
    this.tokenState = deps.tokenState;
    this.security = deps.security;
    this.mailer = deps.mailer;
    this.config = deps.config ?? defaultAuthServiceConfig();
  }

  // ---------------------------------------------------------------------------
  // Registration & email verification
  // ---------------------------------------------------------------------------

  /**
   * Public self-registration. Always creates a CUSTOMER, and always answers the same way whether or
   * not the email is already registered, so the endpoint can't be used to discover customers.
   * The password is hashed in both cases so response timing doesn't differ either.
   */
  public async register(dto: RegisterDTO): Promise<{ message: string }> {
    const email = normaliseEmail(dto.email);
    const passwordHash = await PasswordService.hash(dto.password);

    let created: User | null = null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, passwordHash, role: Role.CUSTOMER },
        });
        await this.stageUserRegistered(tx, user);
        return user;
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }

    if (created) {
      const user = created;
      this.runInBackground('send verification email', () => this.sendVerificationEmail(user));
    } else {
      this.runInBackground('send existing-account email', async () => {
        if (await this.security.consumeEmailQuota('existing-account', email)) {
          await this.mailer.send(existingAccountEmail(email, this.config.appBaseUrl));
        }
      });
    }

    return { message: `Registration received. ${ACCEPTED_MESSAGE} Please verify your email before signing in.` };
  }

  public async verifyEmail(rawToken: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const token = await tx.emailVerificationToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
      if (!token || token.usedAt || token.expiresAt < now) {
        throw new HttpError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This verification link is invalid or has expired');
      }
      // Compare-and-set so a token can only ever be consumed once, even under concurrent requests
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new HttpError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This verification link is invalid or has expired');
      }
      await tx.user.update({ where: { id: token.userId }, data: { isEmailVerified: true } });
    });
  }

  public async resendVerification(rawEmail: string): Promise<{ message: string }> {
    const email = normaliseEmail(rawEmail);
    this.runInBackground('resend verification email', async () => {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user || user.isEmailVerified || !user.isActive) return;
      await this.sendVerificationEmail(user);
    });
    return { message: ACCEPTED_MESSAGE };
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    if (!(await this.security.consumeEmailQuota('verify', user.email))) {
      logger.warn({ userId: user.id }, 'Verification email quota exhausted');
      return;
    }
    const rawToken = newOneTimeToken();
    await this.prisma.$transaction([
      // Only the newest link works
      this.prisma.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(rawToken),
          expiresAt: new Date(Date.now() + this.config.emailVerificationTtlHours * 3600_000),
        },
      }),
    ]);
    await this.mailer.send(
      verificationEmail(user.email, this.config.appBaseUrl, rawToken, this.config.emailVerificationTtlHours)
    );
  }

  /**
   * Creates a user with an explicit role. Only reachable from admin-guarded routes and the bootstrap
   * script; the administrator vouches for the address, so it is created verified.
   */
  public async createStaffUser(dto: Required<RegisterDTO>): Promise<PublicUser> {
    const email = normaliseEmail(dto.email);
    const passwordHash = await PasswordService.hash(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, passwordHash, role: dto.role, isEmailVerified: true },
        });
        await this.stageUserRegistered(tx, created);
        return created;
      });
      return { id: user.id, email: user.email, role: user.role };
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictError('An account with this email already exists');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Login, refresh, logout
  // ---------------------------------------------------------------------------

  public async login(dto: LoginDTO): Promise<AuthResponse> {
    const email = normaliseEmail(dto.email);

    if (await this.security.isLoginLocked(email)) {
      // Same answer for existing and non-existing emails; counters exist for any address tried
      throw new RateLimitExceededError(
        'Too many failed sign-in attempts. Try again later or reset your password.'
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always run one Argon2 verification so response time doesn't reveal whether the email exists
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const isPasswordValid = await PasswordService.verify(hashToCheck, dto.password);

    if (!user || !user.isActive || !isPasswordValid) {
      await this.security.recordLoginFailure(email);
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }

    await this.security.clearLoginFailures(email);

    if (!user.isEmailVerified) {
      // Only revealed after a correct password, so it doesn't leak account existence
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in');
    }

    const tokens = await this.issueTokenPair(user);
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
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

    // TOKEN REUSE ATTACK DETECTION: an already-rotated token presented again means it was stolen
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

    // Compare-and-set: of two concurrent refreshes with the same token, only one can win
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

    return this.createTokensInFamily(record.user, record.familyId);
  }

  /**
   * Ends the session: revokes the refresh-token family and, if the caller presented a valid access
   * token, denylists it in Redis so it stops working immediately instead of at expiry.
   */
  public async logout(rawRefreshToken: string, accessToken?: AuthenticatedUser | null): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (record && (!accessToken || record.userId === accessToken.id)) {
      await this.revokeFamily(record.familyId);
    }

    if (accessToken?.jti && accessToken.expiresAt) {
      await this.tokenState.revokeJti(accessToken.jti, accessToken.expiresAt - Math.floor(Date.now() / 1000));
    }
  }

  // ---------------------------------------------------------------------------
  // Password management
  // ---------------------------------------------------------------------------

  /**
   * Starts a password reset. The response is identical whether or not the account exists, and all
   * work (lookup, token creation, SMTP) happens after the response so timing reveals nothing either.
   */
  public async forgotPassword(rawEmail: string): Promise<{ message: string }> {
    const email = normaliseEmail(rawEmail);
    this.runInBackground('send password reset email', async () => {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive) return;
      if (!(await this.security.consumeEmailQuota('reset', email))) {
        logger.warn({ userId: user.id }, 'Password reset email quota exhausted');
        return;
      }

      const rawToken = newOneTimeToken();
      await this.prisma.$transaction([
        // Only the most recent reset link is valid
        this.prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256(rawToken),
            expiresAt: new Date(Date.now() + this.config.passwordResetTtlMinutes * 60_000),
          },
        }),
      ]);
      await this.mailer.send(
        passwordResetEmail(user.email, this.config.appBaseUrl, rawToken, this.config.passwordResetTtlMinutes)
      );
    });
    return { message: ACCEPTED_MESSAGE };
  }

  /**
   * Completes a reset with a single-use token: sets the new password, signs the user out everywhere
   * (refresh tokens revoked + token version bumped so access tokens die immediately) and notifies them.
   */
  public async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const now = new Date();
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    const invalid = () =>
      new HttpError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This password reset link is invalid or has expired');

    if (!token || token.usedAt || token.expiresAt < now || !token.user.isActive) {
      throw invalid();
    }

    const passwordHash = await PasswordService.hash(newPassword);

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalid();
      return this.applyPasswordChange(tx, token.userId, passwordHash, {
        // Receiving the reset link proves control of the inbox
        isEmailVerified: true,
      });
    });

    await this.afterPasswordChange(user);
  }

  /**
   * Authenticated password change. Requires the current password, signs out every other session and
   * returns a fresh token pair for the caller.
   */
  public async changePassword(
    actor: AuthenticatedUser,
    currentPassword: string,
    newPassword: string
  ): Promise<GeneratedTokens> {
    const existing = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!existing || !existing.isActive) {
      throw new UnauthorizedError();
    }
    if (!(await PasswordService.verify(existing.passwordHash, currentPassword))) {
      throw new UnauthorizedError('Current password is incorrect');
    }
    if (await PasswordService.verify(existing.passwordHash, newPassword)) {
      throw new HttpError(400, 'PASSWORD_REUSED', 'The new password must be different from the current one');
    }

    const passwordHash = await PasswordService.hash(newPassword);
    const user = await this.prisma.$transaction((tx) =>
      this.applyPasswordChange(tx, existing.id, passwordHash, {})
    );
    await this.afterPasswordChange(user);
    return this.issueTokenPair(user);
  }

  private async applyPasswordChange(
    tx: Prisma.TransactionClient,
    userId: string,
    passwordHash: string,
    extra: Partial<Pick<User, 'isEmailVerified'>>
  ): Promise<User> {
    const user = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        ...extra,
      },
    });
    await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    return user;
  }

  private async afterPasswordChange(user: User): Promise<void> {
    await this.publishTokenVersion(user.id, user.tokenVersion);
    await this.security.clearLoginFailures(user.email).catch(() => {});
    this.runInBackground('send password changed email', () =>
      this.mailer.send(passwordChangedEmail(user.email, user.passwordChangedAt ?? new Date())).then(() => {})
    );
  }

  // ---------------------------------------------------------------------------
  // Users & administration
  // ---------------------------------------------------------------------------

  public async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      isEmailVerified: user.isEmailVerified,
      passwordChangedAt: user.passwordChangedAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * Enables or disables a user. Disabling revokes every refresh token and bumps the token version,
   * so the user is locked out immediately, not when their access token expires.
   */
  public async setUserActive(userId: string, isActive: boolean) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundError('User not found');
      }
      const result = await tx.user.update({
        where: { id: userId },
        data: { isActive, ...(isActive ? {} : { tokenVersion: { increment: 1 } }) },
      });
      if (!isActive) {
        await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
      }
      return result;
    });

    if (!isActive) {
      await this.publishTokenVersion(updated.id, updated.tokenVersion);
    }
    return { id: updated.id, email: updated.email, role: updated.role, isActive: updated.isActive };
  }

  /**
   * Re-mirrors every non-zero token version into Redis (run at startup), so a Redis data loss can't
   * resurrect access tokens that were revoked by a password change or account disable.
   */
  public async syncTokenVersions(): Promise<number> {
    let synced = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { tokenVersion: { gt: 0 } },
        select: { id: true, tokenVersion: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const u of batch) {
        await this.tokenState.setTokenVersion(u.id, u.tokenVersion);
      }
      synced += batch.length;
      if (batch.length < 500) return synced;
      cursor = batch[batch.length - 1].id;
    }
  }

  /**
   * Housekeeping: drops expired refresh / reset / verification tokens.
   */
  public async purgeExpiredTokens(): Promise<void> {
    const cutoff = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    ]);
  }

  /** Test helper: waits for fire-and-forget work (emails) to finish */
  public async drainBackgroundTasks(): Promise<void> {
    while (this.background.size) {
      await Promise.allSettled([...this.background]);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async publishTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    // The DB change is committed; retry the Redis mirror a few times. If Redis stays down, the
    // startup re-sync and the 15-minute access-token lifetime bound the exposure.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.tokenState.setTokenVersion(userId, tokenVersion);
        return;
      } catch (err) {
        if (attempt === 3) {
          logger.error({ err, userId }, 'Failed to publish token version to Redis');
          return;
        }
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
  }

  private runInBackground(name: string, task: () => Promise<void>): void {
    const promise = (async () => {
      try {
        await task();
      } catch (err) {
        logger.error({ err }, `Background task failed: ${name}`);
      }
    })();
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
  }

  private async stageUserRegistered(tx: Prisma.TransactionClient, user: User): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'USER',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: {
          eventId: crypto.randomUUID(),
          eventType: 'user.registered.v1',
          timestamp: new Date().toISOString(),
          userId: user.id,
          email: user.email,
          role: user.role,
        },
      },
    });
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

  private issueTokenPair(user: User): Promise<GeneratedTokens> {
    return this.createTokensInFamily(user, crypto.randomUUID());
  }

  private async createTokensInFamily(user: User, familyId: string): Promise<GeneratedTokens> {
    const accessToken = this.tokenService.generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
    const rawRefreshToken = this.tokenService.generateRawRefreshToken();
    const expiresAt = new Date(Date.now() + this.tokenService.refreshTokenTtlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: this.tokenService.hashRefreshToken(rawRefreshToken),
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

