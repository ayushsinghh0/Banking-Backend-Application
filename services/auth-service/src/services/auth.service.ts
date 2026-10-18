import crypto from 'crypto';
import { EnrolmentPurpose, Prisma, PrismaClient, Role, User } from '../../generated/client';
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
  mfaLockedEmail,
  mfaReenrolEmail,
  passwordChangedEmail,
  passwordResetEmail,
  staffActivationEmail,
  verificationEmail,
} from './auth-emails';
import { decryptSecret, encryptSecret, generateTotpSecret, otpauthUri, verifyTotp } from './totp';

export interface RegisterDTO {
  email: string;
  password: string;
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
  enrolmentTtlHours: number;
  /** When set, staff accounts must use this email domain (e.g. "bank.example") */
  staffEmailDomain: string;
}

export const defaultAuthServiceConfig = (): AuthServiceConfig => ({
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24),
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS || 30),
  mfaChallengeTtlSeconds: 300,
  enrolmentTtlHours: Number(process.env.STAFF_ENROLMENT_TTL_HOURS || 24),
  staffEmailDomain: (process.env.STAFF_EMAIL_DOMAIN || '').toLowerCase(),
});

export interface AuthServiceDeps {
  prisma: PrismaClient;
  tokenService: TokenService;
  tokenState: TokenStateStore;
  security: AuthSecurityStore;
  mailer: Mailer;
  config?: AuthServiceConfig;
}

export const STAFF_ROLES: Role[] = [Role.SUPPORT, Role.TELLER, Role.KYC_OFFICER, Role.FRAUD_ANALYST, Role.BANK_ADMIN];

const INVALID_CREDENTIALS = 'Invalid email or password';
const BOOTSTRAP_ADMIN_LIMIT = 2;
const ACCEPTED_MESSAGE =
  'If the address can receive email, a message with further instructions has been sent.';
const REUSE_MESSAGE =
  'Security Alert: Compromised refresh token detected. All active sessions have been terminated. Please log in again.';
/** A rotated refresh token presented again within this window is a concurrent refresh, not theft */
const ROTATION_GRACE_MS = 10_000;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
const newOneTimeToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

type Tx = Prisma.TransactionClient;
type Client = Tx | PrismaClient;

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly tokenService: TokenService;
  private readonly tokenState: TokenStateStore;
  private readonly security: AuthSecurityStore;
  private readonly mailer: Mailer;
  public readonly config: AuthServiceConfig;
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

  // ---------------------------------------------------------------------------
  // Staff onboarding (executed only after four-eyes approval, see AdminRequestService)
  // ---------------------------------------------------------------------------

  public assertStaffEmailAllowed(email: string): void {
    const domain = this.config.staffEmailDomain;
    if (domain && !normaliseEmail(email).endsWith(`@${domain}`)) {
      throw new HttpError(400, 'STAFF_EMAIL_DOMAIN', `Staff accounts must use an @${domain} address`);
    }
  }

  /**
   * Creates a staff user with an unusable random password and emails a one-time activation link: the
   * staff member chooses their own password, no administrator ever knows it.
   */
  public async createStaffUserFromApproval(
    tx: Tx,
    email: string,
    role: Role,
    requestId: string
  ): Promise<{ user: User; activationToken: string }> {
    if (!STAFF_ROLES.includes(role)) throw new HttpError(400, 'INVALID_ROLE', 'Not a staff role');
    this.assertStaffEmailAllowed(email);
    const unusablePassword = await PasswordService.hash(crypto.randomBytes(48).toString('base64url'));
    let user: User;
    try {
      user = await tx.user.create({
        data: { email: normaliseEmail(email), passwordHash: unusablePassword, role, isEmailVerified: true, createdBy: requestId },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictError('An account with this email already exists');
      throw err;
    }
    await this.stageUserRegistered(tx, user);
    const activationToken = await this.createEnrolmentToken(tx, user.id, EnrolmentPurpose.ACTIVATE);
    return { user, activationToken };
  }

  public sendStaffActivation(user: User, activationToken: string): void {
    this.runInBackground('send staff activation email', () =>
      this.mailer
        .send(staffActivationEmail(user.email, this.config.appBaseUrl, activationToken, user.role, this.config.enrolmentTtlHours))
        .then(() => {})
    );
  }

  /**
   * Bootstrap only (operator with database access): first BANK_ADMIN. Returns a one-time MFA enrolment
   * token, which the operator hands to the administrator out of band.
   */
  public async createBootstrapAdmin(email: string, password: string): Promise<{ user: PublicUser; enrolmentToken: string }> {
    const passwordHash = await PasswordService.hash(password);
    return this.prisma.$transaction(async (tx) => {
      // Bootstrap only creates the two administrators four-eyes needs; every later one is a four-eyes request
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('bootstrap-admin', 0))::text`;
      const admins = await tx.user.count({ where: { role: Role.BANK_ADMIN, isActive: true } });
      if (admins >= BOOTSTRAP_ADMIN_LIMIT) {
        throw new ConflictError('Bootstrap is only for the first two administrators; create others with a four-eyes admin request');
      }
      let user: User;
      try {
        user = await tx.user.create({
          data: { email: normaliseEmail(email), passwordHash, role: Role.BANK_ADMIN, isEmailVerified: true, createdBy: 'bootstrap' },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') throw new ConflictError('An account with this email already exists');
        throw err;
      }
      await this.stageUserRegistered(tx, user);
      await this.audit(tx, null, 'BOOTSTRAP_ADMIN_CREATED', user.id);
      logger.warn({ userId: user.id, alert: 'BOOTSTRAP_ADMIN_CREATED' }, 'A bootstrap administrator was created');
      const enrolmentToken = await this.createEnrolmentToken(tx, user.id, EnrolmentPurpose.MFA_ENROL);
      return { user: { id: user.id, email: user.email, role: user.role }, enrolmentToken };
    });
  }

  /**
   * Staff activation: sets the password chosen by the staff member and returns an enrolment-only session
   * plus a one-time MFA enrolment token (the activation link proved control of the mailbox).
   */
  public async activateStaff(rawToken: string, password: string): Promise<{ tokens: GeneratedTokens; enrolmentToken: string }> {
    const passwordHash = await PasswordService.hash(password);
    const { user, enrolmentToken } = await this.prisma.$transaction(async (tx) => {
      const userId = await this.consumeEnrolmentToken(tx, rawToken, EnrolmentPurpose.ACTIVATE);
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
      await this.audit(tx, userId, 'STAFF_ACTIVATED', userId);
      return { user: updated, enrolmentToken: await this.createEnrolmentToken(tx, userId, EnrolmentPurpose.MFA_ENROL) };
    });
    await this.publishTokenVersion(user.id, user.tokenVersion);
    return { tokens: await this.startSession(user, false), enrolmentToken };
  }

  private async createEnrolmentToken(tx: Tx, userId: string, purpose: EnrolmentPurpose): Promise<string> {
    const raw = newOneTimeToken();
    await tx.enrolmentToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
    await tx.enrolmentToken.create({
      data: { userId, purpose, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + this.config.enrolmentTtlHours * 3600_000) },
    });
    return raw;
  }

  /** Single-use compare-and-set; returns the token's user id */
  private async consumeEnrolmentToken(tx: Tx, rawToken: string, purpose: EnrolmentPurpose, expectedUserId?: string): Promise<string> {
    const invalid = () => new HttpError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This enrolment link is invalid or has expired');
    const token = await tx.enrolmentToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt < new Date()) throw invalid();
    if (expectedUserId && token.userId !== expectedUserId) throw invalid();
    const claimed = await tx.enrolmentToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid();
    return token.userId;
  }

  private async assertEnrolmentTokenValid(rawToken: string | undefined, userId: string): Promise<void> {
    const token = rawToken ? await this.prisma.enrolmentToken.findUnique({ where: { tokenHash: sha256(rawToken) } }) : null;
    if (!token || token.purpose !== EnrolmentPurpose.MFA_ENROL || token.usedAt || token.expiresAt < new Date() || token.userId !== userId) {
      throw new HttpError(403, 'ENROLMENT_TOKEN_REQUIRED', 'Staff MFA enrolment requires a valid one-time enrolment token');
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
      if (attempt.stepUpRequired) {
        logger.warn({ alert: 'LOGIN_GLOBAL_LOCKOUT' }, 'Distributed login failures on one account; unknown networks blocked');
        throw new HttpError(
          429,
          'LOGIN_STEP_UP_REQUIRED',
          'Too many failed sign-in attempts on this account. Reset your password by email to continue.'
        );
      }
      // Same answer for existing and non-existing emails; counters exist for any address tried
      throw new RateLimitExceededError('Too many failed sign-in attempts. Try again later or reset your password.');
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
      const challengeToken = await this.security.createMfaChallenge(user.id, user.tokenVersion, this.config.mfaChallengeTtlSeconds);
      return { mfaRequired: true, challengeToken, expiresInSeconds: this.config.mfaChallengeTtlSeconds };
    }

    // tokenVersion as read BEFORE the password check: a reset committing meanwhile invalidates this login
    const tokens = await this.startSession(user, false, user.tokenVersion);
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
  }

  /**
   * Second login step: a valid TOTP code for the challenge's user. Attempts are counted atomically before
   * verification; codes are single-use; and a per-user failure budget (independent of the password) pauses
   * TOTP sign-in after repeated failures and alerts the user.
   */
  public async completeMfaLogin(challengeToken: string, code: string): Promise<AuthResponse> {
    const invalid = () => new UnauthorizedError('Invalid or expired verification code');
    const challenge = await this.security.consumeMfaChallengeAttempt(challengeToken);
    if (!challenge) throw invalid();
    const { userId } = challenge;

    if (await this.security.isMfaLocked(userId)) {
      await this.security.deleteMfaChallenge(challengeToken);
      throw new HttpError(429, 'MFA_TEMPORARILY_LOCKED', 'Too many failed verification codes. Try again later.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEnc) {
      await this.security.deleteMfaChallenge(challengeToken);
      throw invalid();
    }

    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, user.id), code);
    if (step === null || !(await this.consumeTotpStep(user.id, step))) {
      const failures = await this.security.recordMfaFailure(user.id);
      if (await this.security.isMfaLocked(user.id)) {
        await this.security.deleteMfaChallenge(challengeToken);
        if (failures === Number(process.env.MFA_MAX_FAILURES_PER_HOUR || 10)) {
          logger.warn({ userId: user.id, alert: 'MFA_BRUTE_FORCE' }, 'TOTP sign-in paused after repeated failures');
          this.runInBackground('send MFA locked email', () => this.mailer.send(mfaLockedEmail(user.email)).then(() => {}));
        }
      }
      throw invalid();
    }

    await this.security.deleteMfaChallenge(challengeToken);
    await this.security.clearMfaFailures(user.id);
    // Bound to the token version at password time: a reset since then kills this half-finished login
    const tokens = await this.startSession(user, true, challenge.tokenVersion, true);
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
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
   * which serialises it with password changes/resets/disables. A token rotated a few seconds ago (two
   * tabs refreshing at once) gets a retryable 409 instead of nuking the session.
   */
  public async refreshToken(rawRefreshToken: string): Promise<GeneratedTokens> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);

    type Outcome =
      | { kind: 'ok'; tokens: GeneratedTokens }
      | { kind: 'reuse' | 'disabled'; familyId: string }
      | { kind: 'invalid' | 'expired' | 'concurrent' };

    const outcome: Outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
      const found = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!found) return { kind: 'invalid' };

      await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId} FOR UPDATE`;
      // Re-read under the lock: a concurrent reset/refresh may have changed it while we waited
      const record = await tx.refreshToken.findUniqueOrThrow({ where: { id: found.id }, include: { user: true } });

      if (record.isRevoked) {
        if (record.rotatedAt && Date.now() - record.rotatedAt.getTime() < ROTATION_GRACE_MS) return { kind: 'concurrent' };
        return { kind: 'reuse', familyId: record.familyId };
      }
      const now = new Date();
      if (now > record.expiresAt || now > record.familyExpiresAt) return { kind: 'expired' };
      if (!record.user.isActive) return { kind: 'disabled', familyId: record.familyId };

      await tx.refreshToken.update({ where: { id: record.id }, data: { isRevoked: true, rotatedAt: now } });
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
      case 'concurrent':
        throw new HttpError(409, 'REFRESH_IN_PROGRESS', 'This session was just refreshed by another request; use the newest tokens.');
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
  // MFA enrolment (re-authentication required; staff also need a one-time enrolment token)
  // ---------------------------------------------------------------------------

  private async reauthenticate(user: User, password: string): Promise<void> {
    if (!(await PasswordService.verify(user.passwordHash, password))) {
      throw new UnauthorizedError('Password is incorrect');
    }
  }

  /** Starts (or restarts) enrolment: returns a new secret to load into an authenticator app */
  public async beginMfaSetup(
    actor: AuthenticatedUser,
    password: string,
    enrolmentToken?: string
  ): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.requireActiveUser(actor.id);
    if (user.mfaEnabled) throw new ConflictError('MFA is already enabled for this account');
    await this.reauthenticate(user, password);
    if (isStaffRole(user.role)) await this.assertEnrolmentTokenValid(enrolmentToken, user.id);

    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaPendingSecretEnc: encryptSecret(secret, user.id) },
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /**
   * Confirms enrolment with a code from the authenticator. Every OTHER session is revoked; the caller's
   * own session is upgraded in place (same family, same absolute expiry) rather than replaced by a new
   * 30-day session.
   */
  public async enableMfa(actor: AuthenticatedUser, code: string, enrolmentToken?: string): Promise<GeneratedTokens> {
    const user = await this.requireActiveUser(actor.id);
    if (user.mfaEnabled) throw new ConflictError('MFA is already enabled for this account');
    if (!user.mfaPendingSecretEnc) throw new HttpError(400, 'MFA_SETUP_REQUIRED', 'Start MFA setup first');
    if (!actor.sessionId) throw new UnauthorizedError();

    const secret = decryptSecret(user.mfaPendingSecretEnc, user.id);
    const step = verifyTotp(secret, code);
    if (step === null) throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');

    const { updated, familyExpiresAt } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      if (isStaffRole(user.role)) {
        if (!enrolmentToken) throw new HttpError(403, 'ENROLMENT_TOKEN_REQUIRED', 'Staff MFA enrolment requires a valid one-time enrolment token');
        await this.consumeEnrolmentToken(tx, enrolmentToken, EnrolmentPurpose.MFA_ENROL, user.id);
      }
      const current = await tx.refreshToken.findFirst({
        where: { userId: user.id, familyId: actor.sessionId, isRevoked: false },
      });
      if (!current) throw new UnauthorizedError('Your session is no longer valid');
      const result = await tx.user.update({
        where: { id: user.id },
        data: {
          mfaEnabled: true,
          mfaEnabledAt: new Date(),
          mfaSecretEnc: encryptSecret(secret, user.id),
          mfaPendingSecretEnc: null,
          mfaLastUsedStep: step,
          tokenVersion: { increment: 1 },
        },
      });
      // Every session, including the current refresh token, is revoked; the current session continues
      // only through the new tokens issued below in the same family
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      await this.audit(tx, user.id, 'MFA_ENABLED', user.id);
      return { updated: result, familyExpiresAt: current.familyExpiresAt };
    });

    await this.publishTokenVersion(updated.id, updated.tokenVersion);
    this.runInBackground('send MFA changed email', () =>
      this.mailer.send(mfaChangedEmail(updated.email, true)).then(() => {})
    );
    // The code just verified is a fresh TOTP check; the factor-age rule still keeps a brand-new factor
    // from authorising high-risk actions in production
    return this.createTokensInFamily(
      this.prisma,
      updated,
      { familyId: actor.sessionId, familyExpiresAt, mfaAuthenticated: true },
      true
    );
  }

  /**
   * Re-verifies the second factor inside an existing MFA session and returns a short-lived access token
   * marked as recently strongly authenticated (needed for large transfers and instant payees).
   */
  public async stepUp(actor: AuthenticatedUser, code: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const user = await this.requireActiveUser(actor.id);
    if (!actor.mfa || !actor.sessionId || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new HttpError(403, 'MFA_REQUIRED', 'Sign in with two-factor authentication first');
    }
    if (await this.security.isMfaLocked(user.id)) {
      throw new HttpError(429, 'MFA_TEMPORARILY_LOCKED', 'Too many failed verification codes. Try again later.');
    }
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, user.id), code);
    if (step === null || !(await this.consumeTotpStep(user.id, step))) {
      await this.security.recordMfaFailure(user.id);
      throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');
    }
    await this.security.clearMfaFailures(user.id);
    const session = await this.prisma.refreshToken.findFirst({ where: { userId: user.id, familyId: actor.sessionId, isRevoked: false } });
    if (!session) throw new UnauthorizedError('Your session is no longer valid');
    await this.audit(this.prisma, user.id, 'MFA_STEP_UP', user.id);
    return { accessToken: this.accessTokenFor(user, actor.sessionId, true, true), expiresInSeconds: this.tokenService.accessTokenTtlSeconds };
  }

  /**
   * Customers may turn MFA off with their password and a current code. Staff cannot: MFA is
   * mandatory for them and only a four-eyes administrative reset can clear it.
   */
  public async disableMfa(actor: AuthenticatedUser, password: string, code: string): Promise<void> {
    const user = await this.requireActiveUser(actor.id);
    if (isStaffRole(user.role)) {
      throw new ForbiddenError('MFA is mandatory for staff accounts');
    }
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new ConflictError('MFA is not enabled');
    await this.reauthenticate(user, password);
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, user.id), code);
    if (step === null || !(await this.consumeTotpStep(user.id, step))) {
      throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaEnabledAt: null, mfaSecretEnc: null, mfaPendingSecretEnc: null, tokenVersion: { increment: 1 } },
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

  /**
   * Clears a user's MFA (lost authenticator) and signs them out everywhere. For staff a one-time
   * re-enrolment token is emailed. Called directly for customers, and via an approved admin request for staff.
   */
  public async resetMfaInTx(tx: Tx, actorId: string, userId: string): Promise<{ user: User; enrolmentToken?: string }> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User not found');
    const result = await tx.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaEnabledAt: null, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastUsedStep: null, tokenVersion: { increment: 1 } },
    });
    await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
    await this.audit(tx, actorId, 'MFA_RESET', userId);
    const enrolmentToken = isStaffRole(user.role) ? await this.createEnrolmentToken(tx, userId, EnrolmentPurpose.MFA_ENROL) : undefined;
    return { user: result, enrolmentToken };
  }

  public async afterMfaReset(user: User, enrolmentToken?: string): Promise<void> {
    await this.publishTokenVersion(user.id, user.tokenVersion);
    this.runInBackground('send MFA reset email', () =>
      this.mailer
        .send(enrolmentToken ? mfaReenrolEmail(user.email, this.config.appBaseUrl, enrolmentToken, this.config.enrolmentTtlHours) : mfaChangedEmail(user.email, false))
        .then(() => {})
    );
  }

  /**
   * Removing anyone's second factor is a takeover primitive (it re-opens password-only access), so it is
   * always a four-eyes request, for customers as well as staff.
   */
  public async adminResetCustomerMfa(_admin: AuthenticatedUser, userId: string): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundError('User not found');
    throw new HttpError(409, 'APPROVAL_REQUIRED', 'Resetting MFA requires a four-eyes admin request');
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
    return this.startSession(user, Boolean(actor.mfa), user.tokenVersion);
  }

  private async applyPasswordChange(
    tx: Tx,
    userId: string,
    passwordHash: string,
    extra: Partial<Pick<User, 'isEmailVerified'>>
  ): Promise<User> {
    // Same row lock as refreshToken()/startSession(): serialises with in-flight logins and refreshes
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
    await this.security.clearMfaFailures(user.id).catch(() => {});
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
   * Enables/disables a user inside the caller's transaction. Disabling revokes every refresh token and
   * bumps the token version, so the user is locked out immediately.
   */
  public async setUserActiveInTx(tx: Tx, actorId: string, userId: string, isActive: boolean): Promise<User> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User not found');
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const result = await tx.user.update({
      where: { id: userId },
      data: { isActive, ...(isActive ? {} : { tokenVersion: { increment: 1 } }) },
    });
    if (!isActive) {
      await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
    }
    await this.audit(tx, actorId, isActive ? 'USER_ENABLED' : 'USER_DISABLED', userId);
    return result;
  }

  public async afterUserActiveChange(user: User): Promise<void> {
    if (!user.isActive) await this.publishTokenVersion(user.id, user.tokenVersion);
  }

  /**
   * One administrator may suspend or reinstate a CUSTOMER directly (fast fraud response). Staff
   * accounts can only be changed through a four-eyes admin request.
   */
  public async setCustomerActive(admin: AuthenticatedUser, userId: string, isActive: boolean) {
    if (admin.id === userId) throw new ForbiddenError('Administrators cannot change their own status');
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundError('User not found');
    if (isStaffRole(target.role)) {
      throw new HttpError(409, 'APPROVAL_REQUIRED', 'Changing a staff account requires a four-eyes admin request');
    }
    if (isActive && !target.isActive) {
      const lastDisable = await this.prisma.auditLog.findFirst({
        where: { targetId: userId, action: 'USER_DISABLED' },
        orderBy: { createdAt: 'desc' },
      });
      if (lastDisable?.actorId === admin.id) {
        throw new ForbiddenError('A user you disabled must be re-enabled by a different administrator');
      }
    }
    const updated = await this.prisma.$transaction((tx) => this.setUserActiveInTx(tx, admin.id, userId, isActive));
    await this.afterUserActiveChange(updated);
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

  /** Lookback for the periodic sync: at least twice the access-token lifetime */
  public syncLookbackMs(): number {
    return Math.max(10 * 60_000, 2 * this.tokenService.accessTokenTtlSeconds * 1000);
  }

  /**
   * Housekeeping: drops expired refresh / reset / verification / enrolment tokens.
   */
  public async purgeExpiredTokens(): Promise<void> {
    const cutoff = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { familyExpiresAt: { lt: cutoff } }] } }),
      this.prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.enrolmentToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
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

  public async publishTokenVersion(userId: string, tokenVersion: number): Promise<void> {
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

  public runInBackground(name: string, task: () => Promise<void>): void {
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

  public async audit(
    tx: Client,
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

  /** Ends a session: its refresh tokens AND every access token issued in it (via the session denylist) */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId },
      data: { isRevoked: true },
    });
    try {
      await this.tokenState.revokeSession(familyId, this.tokenService.accessTokenTtlSeconds);
    } catch (err) {
      // The refresh tokens are dead; outstanding access tokens then expire on their own within minutes
      logger.error({ err, alert: 'SESSION_DENYLIST_FAILED' }, 'Could not denylist the revoked session in Redis');
    }
  }

  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = PasswordService.hash(crypto.randomBytes(32).toString('hex'));
    }
    return this.dummyHashPromise;
  }

  /**
   * New session (new token family) with an absolute lifetime of SESSION_MAX_DAYS. Created under the user
   * row lock and only if the user's token version still equals `expectedVersion` (read before the
   * credential check), so a password reset/disable committing in between can't be outlived by this login.
   */
  private async startSession(user: User, mfaAuthenticated: boolean, expectedVersion?: number, stepUp = false): Promise<GeneratedTokens> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!fresh.isActive || (expectedVersion !== undefined && fresh.tokenVersion !== expectedVersion)) {
        throw new UnauthorizedError('Your credentials changed while signing in. Please sign in again.');
      }
      return this.createTokensInFamily(
        tx,
        fresh,
        {
          familyId: crypto.randomUUID(),
          familyExpiresAt: new Date(Date.now() + this.config.sessionMaxDays * 86400_000),
          mfaAuthenticated,
        },
        stepUp
      );
    });
  }

  /** stepUp: this token is issued right after a TOTP verification (recent strong authentication) */
  private accessTokenFor(user: User, sessionId: string, mfa: boolean, stepUp: boolean): string {
    return this.tokenService.generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
      mfa,
      sessionId,
      stepUpAt: stepUp ? Math.floor(Date.now() / 1000) : undefined,
      mfaSince: mfa && user.mfaEnabledAt ? Math.floor(user.mfaEnabledAt.getTime() / 1000) : undefined,
    });
  }

  private async createTokensInFamily(
    client: Client,
    user: User,
    family: { familyId: string; familyExpiresAt: Date; mfaAuthenticated: boolean },
    stepUp = false
  ): Promise<GeneratedTokens> {
    const accessToken = this.accessTokenFor(user, family.familyId, family.mfaAuthenticated, stepUp);
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
