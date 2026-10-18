import crypto from 'crypto';
import { Prisma, PrismaClient, Role, User } from '../../generated/client';
import {
  AuthenticatedUser,
  ConflictError,
  ForbiddenError,
  HttpError,
  Mailer,
  NotFoundError,
  RateLimitExceededError,
  TokenStateStore,
  UnauthorizedError,
  isStaffRole,
  logger,
} from '@banksphere/common';
import { PasswordService } from './password.service';
import { TokenService, GeneratedTokens } from './token.service';
import { AuthSecurityStore } from './auth-security.store';
import {
  existingAccountEmail,
  mfaChangedEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './auth-emails';
import { decryptSecret, encryptSecret, generateTotpSecret, otpauthUri, verifyTotp } from './totp';

export interface RegisterDTO {
  email: string;
  password: string;
  role?: Role;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface LoginContext {
  /** Normalised client network (IPv4 address or IPv6 /64) used for lockout keying */
  network: string;
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

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  expiresInSeconds: number;
}

export interface AuthServiceConfig {
  appBaseUrl: string;
  passwordResetTtlMinutes: number;
  emailVerificationTtlHours: number;
  sessionMaxDays: number;
  mfaChallengeTtlSeconds: number;
}

export const defaultAuthServiceConfig = (): AuthServiceConfig => ({
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24),
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS || 30),
  mfaChallengeTtlSeconds: 300,
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
const REUSE_MESSAGE =
  'Security Alert: Compromised refresh token detected. All active sessions have been terminated. Please log in again.';

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
const newOneTimeToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

type Tx = Prisma.TransactionClient;

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
        await this.audit(tx, user.id, 'USER_REGISTERED', user.id);
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
    const invalid = () =>
      new HttpError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This verification link is invalid or has expired');
    await this.prisma.$transaction(async (tx) => {
      const token = await tx.emailVerificationToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
      if (!token || token.usedAt || token.expiresAt < now) throw invalid();
      // Compare-and-set so a token can only ever be consumed once, even under concurrent requests
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalid();
      await tx.user.update({ where: { id: token.userId }, data: { isEmailVerified: true } });
      await this.audit(tx, token.userId, 'EMAIL_VERIFIED', token.userId);
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
   * script; the administrator vouches for the address, so it is created verified. Staff must still
   * enrol MFA before they can use any privileged API.
   */
  public async createStaffUser(dto: Required<RegisterDTO>, actorId: string | null): Promise<PublicUser> {
    const email = normaliseEmail(dto.email);
    const passwordHash = await PasswordService.hash(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, passwordHash, role: dto.role, isEmailVerified: true },
        });
        await this.stageUserRegistered(tx, created);
        await this.audit(tx, actorId, actorId ? 'STAFF_USER_CREATED' : 'BOOTSTRAP_ADMIN_CREATED', created.id, {
          role: dto.role,
        });
        return created;
      });
      return { id: user.id, email: user.email, role: user.role };
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictError('An account with this email already exists');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Login (password, then TOTP when enrolled), refresh, logout
  // ---------------------------------------------------------------------------

  public async login(dto: LoginDTO, ctx: LoginContext): Promise<AuthResponse | MfaChallengeResponse> {
    const email = normaliseEmail(dto.email);

    // Counted before the password check, so parallel bursts can't exceed the limit
    const attempt = await this.security.beginLoginAttempt(email, ctx.network);
    if (attempt.locked) {
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
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }

    await this.security.loginSucceeded(email, ctx.network);

    if (!user.isEmailVerified) {
      // Only revealed after a correct password, so it doesn't leak account existence
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in');
    }

    if (user.mfaEnabled) {
      const challengeToken = await this.security.createMfaChallenge(user.id, this.config.mfaChallengeTtlSeconds);
      return { mfaRequired: true, challengeToken, expiresInSeconds: this.config.mfaChallengeTtlSeconds };
    }

    const tokens = await this.startSession(user, false);
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
  }

  /**
   * Second login step: a valid TOTP code for the challenge's user. Codes are single-use (replay of a
   * code, even inside its 30s window, is refused) and a challenge allows 5 wrong codes.
   */
  public async completeMfaLogin(challengeToken: string, code: string): Promise<AuthResponse> {
    const invalid = () => new UnauthorizedError('Invalid or expired verification code');
    const userId = await this.security.peekMfaChallenge(challengeToken);
    if (!userId) throw invalid();

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEnc) {
      await this.security.deleteMfaChallenge(challengeToken);
      throw invalid();
    }

    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, user.id), code);
    if (step === null || !(await this.consumeTotpStep(user.id, step))) {
      await this.security.recordMfaChallengeFailure(challengeToken);
      throw invalid();
    }

    await this.security.deleteMfaChallenge(challengeToken);
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const tokens = await this.startSession(fresh, true);
    return { user: { id: fresh.id, email: fresh.email, role: fresh.role }, tokens };
  }

  /** Atomically records the last used TOTP step; false if this (or a later) step was already used */
  private async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
      data: { mfaLastUsedStep: step },
    });
    return result.count === 1;
  }

  /**
   * Rotates a refresh token with REUSE DETECTION. Runs in one transaction holding the user's row lock,
   * which serialises it with password changes/resets/disables: a refresh can never slip a new session in
   * between a reset's "revoke all sessions" and its commit.
   */
  public async refreshToken(rawRefreshToken: string): Promise<GeneratedTokens> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);

    type Outcome =
      | { kind: 'ok'; tokens: GeneratedTokens }
      | { kind: 'reuse' | 'disabled'; familyId: string }
      | { kind: 'invalid' | 'expired' };

    const outcome: Outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
      const found = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!found) return { kind: 'invalid' };

      await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId} FOR UPDATE`;
      // Re-read under the lock: a concurrent reset/refresh may have changed it while we waited
      const record = await tx.refreshToken.findUniqueOrThrow({ where: { id: found.id }, include: { user: true } });

      if (record.isRevoked) return { kind: 'reuse', familyId: record.familyId };
      const now = new Date();
      if (now > record.expiresAt || now > record.familyExpiresAt) return { kind: 'expired' };
      if (!record.user.isActive) return { kind: 'disabled', familyId: record.familyId };

      await tx.refreshToken.update({ where: { id: record.id }, data: { isRevoked: true } });
      const tokens = await this.createTokensInFamily(tx, record.user, {
        familyId: record.familyId,
        familyExpiresAt: record.familyExpiresAt,
        mfaAuthenticated: record.mfaAuthenticated,
      });
      return { kind: 'ok', tokens };
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.tokens;
      case 'invalid':
        throw new UnauthorizedError('Invalid refresh token');
      case 'expired':
        throw new UnauthorizedError('Your session has expired. Please log in again.');
      case 'disabled':
        await this.revokeFamily(outcome.familyId);
        throw new UnauthorizedError('Account is disabled');
      case 'reuse':
        // Token theft: kill the whole session family
        await this.revokeFamily(outcome.familyId);
        throw new UnauthorizedError(REUSE_MESSAGE);
    }
  }

  /**
   * Ends the session: revokes the refresh-token family and, if the caller presented a valid access
   * token, denylists it in Redis so it stops working immediately instead of at expiry.
   */
  public async logout(rawRefreshToken: string, accessToken?: AuthenticatedUser | null): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (record && (!accessToken || record.userId === accessToken.id)) {
      await this.revokeFamily(record.familyId);
    }

    if (accessToken?.jti && accessToken.expiresAt) {
      await this.tokenState.revokeJti(accessToken.jti, accessToken.expiresAt - Math.floor(Date.now() / 1000));
    }
  }

  // ---------------------------------------------------------------------------
  // MFA enrolment
  // ---------------------------------------------------------------------------

  /** Starts (or restarts) enrolment: returns a new secret to load into an authenticator app */
  public async beginMfaSetup(actor: AuthenticatedUser): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.requireActiveUser(actor.id);
    if (user.mfaEnabled) {
      throw new ConflictError('MFA is already enabled for this account');
    }
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaPendingSecretEnc: encryptSecret(secret, user.id) },
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /**
   * Confirms enrolment with a code from the authenticator. All existing sessions (which were not
   * MFA-authenticated) are revoked and a fresh MFA-authenticated session is returned.
   */
  public async enableMfa(actor: AuthenticatedUser, code: string): Promise<GeneratedTokens> {
    const user = await this.requireActiveUser(actor.id);
    if (user.mfaEnabled) throw new ConflictError('MFA is already enabled for this account');
    if (!user.mfaPendingSecretEnc) throw new HttpError(400, 'MFA_SETUP_REQUIRED', 'Start MFA setup first');

    const secret = decryptSecret(user.mfaPendingSecretEnc, user.id);
    const step = verifyTotp(secret, code);
    if (step === null) throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const result = await tx.user.update({
        where: { id: user.id },
        data: {
          mfaEnabled: true,
          mfaSecretEnc: encryptSecret(secret, user.id),
          mfaPendingSecretEnc: null,
          mfaLastUsedStep: step,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      await this.audit(tx, user.id, 'MFA_ENABLED', user.id);
      return result;
    });

    await this.publishTokenVersion(updated.id, updated.tokenVersion);
    this.runInBackground('send MFA changed email', () =>
      this.mailer.send(mfaChangedEmail(updated.email, true)).then(() => {})
    );
    return this.startSession(updated, true);
  }

  /**
   * Customers may turn MFA off with their password and a current code. Staff cannot: MFA is
   * mandatory for them and only another administrator can reset it.
   */
  public async disableMfa(actor: AuthenticatedUser, password: string, code: string): Promise<void> {
    const user = await this.requireActiveUser(actor.id);
    if (isStaffRole(user.role)) {
      throw new ForbiddenError('MFA is mandatory for staff accounts');
    }
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new ConflictError('MFA is not enabled');
    if (!(await PasswordService.verify(user.passwordHash, password))) {
      throw new UnauthorizedError('Password is incorrect');
    }
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, user.id), code);
    if (step === null || !(await this.consumeTotpStep(user.id, step))) {
      throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      await this.audit(tx, user.id, 'MFA_DISABLED', user.id);
      return result;
    });
    await this.publishTokenVersion(updated.id, updated.tokenVersion);
    this.runInBackground('send MFA changed email', () =>
      this.mailer.send(mfaChangedEmail(updated.email, false)).then(() => {})
    );
  }

  /** Lost authenticator: another administrator clears MFA; the user must re-enrol at next login */
  public async adminResetMfa(admin: AuthenticatedUser, userId: string): Promise<void> {
    if (admin.id === userId) throw new ForbiddenError('Administrators cannot reset their own MFA');
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundError('User not found');
      const result = await tx.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: false,
          mfaSecretEnc: null,
          mfaPendingSecretEnc: null,
          mfaLastUsedStep: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
      await this.audit(tx, admin.id, 'MFA_RESET_BY_ADMIN', userId);
      return result;
    });
    await this.publishTokenVersion(updated.id, updated.tokenVersion);
    this.runInBackground('send MFA changed email', () =>
      this.mailer.send(mfaChangedEmail(updated.email, false)).then(() => {})
    );
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
   * MFA, if enrolled, stays required at the next login.
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
      const updated = await this.applyPasswordChange(tx, token.userId, passwordHash, {
        // Receiving the reset link proves control of the inbox
        isEmailVerified: true,
      });
      await this.audit(tx, token.userId, 'PASSWORD_RESET', token.userId);
      return updated;
    });

    await this.afterPasswordChange(user);
  }

  /**
   * Authenticated password change. Requires the current password, signs out every other session and
   * returns a fresh token pair for the caller (keeping its MFA status).
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
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await this.applyPasswordChange(tx, existing.id, passwordHash, {});
      await this.audit(tx, existing.id, 'PASSWORD_CHANGED', existing.id);
      return updated;
    });
    await this.afterPasswordChange(user);
    return this.startSession(user, Boolean(actor.mfa));
  }

  private async applyPasswordChange(
    tx: Tx,
    userId: string,
    passwordHash: string,
    extra: Partial<Pick<User, 'isEmailVerified'>>
  ): Promise<User> {
    // Same row lock as refreshToken(): serialises with in-flight refreshes
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
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
    await this.security.clearAllLoginFailures(user.email).catch(() => {});
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
      mfaEnabled: user.mfaEnabled,
      passwordChangedAt: user.passwordChangedAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * Enables or disables a user. Disabling revokes every refresh token and bumps the token version,
   * so the user is locked out immediately, not when their access token expires.
   */
  public async setUserActive(admin: AuthenticatedUser, userId: string, isActive: boolean) {
    if (admin.id === userId) throw new ForbiddenError('Administrators cannot change their own status');
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundError('User not found');
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const result = await tx.user.update({
        where: { id: userId },
        data: { isActive, ...(isActive ? {} : { tokenVersion: { increment: 1 } }) },
      });
      if (!isActive) {
        await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
      }
      await this.audit(tx, admin.id, isActive ? 'USER_ENABLED' : 'USER_DISABLED', userId);
      return result;
    });

    if (!isActive) {
      await this.publishTokenVersion(updated.id, updated.tokenVersion);
    }
    return { id: updated.id, email: updated.email, role: updated.role, isActive: updated.isActive };
  }

  /**
   * Mirrors token versions into Redis. At startup every non-zero version is synced; periodically, only
   * recently changed users, so a Redis write that failed during a reset is repaired within seconds.
   */
  public async syncTokenVersions(changedSince?: Date): Promise<number> {
    let synced = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { tokenVersion: { gt: 0 }, ...(changedSince ? { updatedAt: { gte: changedSince } } : {}) },
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
      this.prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { familyExpiresAt: { lt: cutoff } }] } }),
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

  private async requireActiveUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedError();
    return user;
  }

  private async publishTokenVersion(userId: string, tokenVersion: number): Promise<void> {
    // The DB change is committed; retry the Redis mirror a few times. If Redis stays down, the periodic
    // re-sync repairs it as soon as Redis is back (and authentication fails closed meanwhile).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.tokenState.setTokenVersion(userId, tokenVersion);
        return;
      } catch (err) {
        if (attempt === 3) {
          logger.error({ err, userId }, 'Failed to publish token version to Redis; periodic sync will repair it');
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

  private async audit(
    tx: Tx,
    actorId: string | null,
    action: string,
    targetId: string | null,
    details?: Record<string, unknown>
  ): Promise<void> {
    await tx.auditLog.create({
      data: { actorId, action, targetId, details: details as Prisma.InputJsonValue | undefined },
    });
  }

  private async stageUserRegistered(tx: Tx, user: User): Promise<void> {
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

  /** New session (new token family) with an absolute lifetime of SESSION_MAX_DAYS */
  private startSession(user: User, mfaAuthenticated: boolean): Promise<GeneratedTokens> {
    return this.createTokensInFamily(this.prisma, user, {
      familyId: crypto.randomUUID(),
      familyExpiresAt: new Date(Date.now() + this.config.sessionMaxDays * 86400_000),
      mfaAuthenticated,
    });
  }

  private async createTokensInFamily(
    client: Tx | PrismaClient,
    user: User,
    family: { familyId: string; familyExpiresAt: Date; mfaAuthenticated: boolean }
  ): Promise<GeneratedTokens> {
    const accessToken = this.tokenService.generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
      mfa: family.mfaAuthenticated,
    });
    const rawRefreshToken = this.tokenService.generateRawRefreshToken();
    // Sliding idle timeout, capped by the absolute session lifetime
    const expiresAt = new Date(
      Math.min(Date.now() + this.tokenService.refreshTokenTtlMs, family.familyExpiresAt.getTime())
    );

    await client.refreshToken.create({
      data: {
        userId: user.id,
        familyId: family.familyId,
        familyExpiresAt: family.familyExpiresAt,
        mfaAuthenticated: family.mfaAuthenticated,
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
