import crypto from 'crypto';
import net from 'net';
import { EnrolmentPurpose, Prisma, PrismaClient, Role, SecurityEventType, User } from '../../generated/client';
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
  counter,
  isAddressAllowed,
  isStaffRole,
  logger,
  staffNetworkError,
  staffNetworksFromEnv,
} from '@banksphere/common';
import { PasswordService } from './password.service';
import { writeAudit } from './audit';
import { Cidr, cidrsOverlap, maskIp, parseCidr, parseCidrList } from './ip-address';
import { EdgeSecurityStore, InMemoryEdgeSecurityStore } from './edge-security.store';
import { SecurityEvents } from './security-events';
import { ClientContext, describeClient, SessionService } from './sessions';
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
  /** Normalised client network (IPv4 address or IPv6 /64) used for lockout keying; also the edge ban key */
  network: string;
  /** Client address, checked against the staff network allowlist (unknown = outside it) */
  ip?: string;
  /** User-Agent header: labels the session's device */
  userAgent?: string;
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

/** A row of the staff user directory (GET /admin/users) */
export interface DirectoryUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  isEmailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
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
  /** STAFF_ALLOWED_CIDRS: staff may only sign in from these networks (null/absent = anywhere) */
  staffNetworks?: net.BlockList | null;
  /** The same networks as exact CIDRs: addresses inside them are never banned automatically */
  staffCidrs?: Cidr[];
  /** Distinct accounts with failed sign-ins from one address in 10 minutes above which it is banned (20) */
  credentialStuffingThreshold?: number;
  /** Length of an automatic credential-stuffing ban (30 minutes) */
  credentialStuffingBanMinutes?: number;
}

export const defaultAuthServiceConfig = (): AuthServiceConfig => ({
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24),
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS || 30),
  mfaChallengeTtlSeconds: 300,
  enrolmentTtlHours: Number(process.env.STAFF_ENROLMENT_TTL_HOURS || 24),
  staffEmailDomain: (process.env.STAFF_EMAIL_DOMAIN || '').toLowerCase(),
  staffNetworks: staffNetworksFromEnv(),
  staffCidrs: parseCidrList(process.env.STAFF_ALLOWED_CIDRS),
  credentialStuffingThreshold: positiveInt('CREDENTIAL_STUFFING_THRESHOLD', 20),
  credentialStuffingBanMinutes: positiveInt('CREDENTIAL_STUFFING_BAN_MINUTES', 30),
});

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number`);
  return value;
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  tokenService: TokenService;
  tokenState: TokenStateStore;
  security: AuthSecurityStore;
  mailer: Mailer;
  config?: AuthServiceConfig;
  /** Edge Redis: credential-stuffing counters and bans (in memory when omitted, e.g. unit tests) */
  edge?: EdgeSecurityStore;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loginsTotal = counter('auth_logins_total', 'Sign-in attempts by outcome', ['result']);
const ipBansTotal = counter('auth_ip_bans_total', 'Client addresses banned at the edge for credential stuffing');

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
  public readonly events: SecurityEvents;
  public readonly sessions: SessionService;
  public readonly edge: EdgeSecurityStore;
  private dummyHashPromise: Promise<string> | null = null;
  private readonly background = new Set<Promise<void>>();

  constructor(deps: AuthServiceDeps) {
    this.prisma = deps.prisma;
    this.tokenService = deps.tokenService;
    this.tokenState = deps.tokenState;
    this.security = deps.security;
    this.mailer = deps.mailer;
    this.config = deps.config ?? defaultAuthServiceConfig();
    this.edge = deps.edge ?? new InMemoryEdgeSecurityStore();
    this.events = new SecurityEvents(deps.prisma);
    this.sessions = new SessionService({
      prisma: deps.prisma,
      tokenState: deps.tokenState,
      events: this.events,
      accessTokenTtlSeconds: deps.tokenService.accessTokenTtlSeconds,
      refreshTokenTtlMs: deps.tokenService.refreshTokenTtlMs,
    });
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
    const accepted = { message: `Registration received. ${ACCEPTED_MESSAGE} Please verify your email before signing in.` };

    if (this.isStaffEmail(email)) {
      // Staff accounts only come from a four-eyes request. Self-registering a staff address would squat a
      // future staff email (and block its CREATE_STAFF), so it is answered like an existing account
      logger.warn({ alert: 'STAFF_DOMAIN_SELF_REGISTRATION' }, 'Self-registration attempted with a staff-domain address');
      this.runInBackground('send existing-account email', async () => {
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing && (await this.security.consumeEmailQuota('existing-account', email))) {
          await this.mailer.send(existingAccountEmail(email, this.config.appBaseUrl));
        }
      });
      return accepted;
    }

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

    return accepted;
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
    if (domain && !this.isStaffEmail(email)) {
      throw new HttpError(400, 'STAFF_EMAIL_DOMAIN', `Staff accounts must use an @${domain} address`);
    }
  }

  /** True for addresses in STAFF_EMAIL_DOMAIN (false when no staff domain is configured) */
  private isStaffEmail(email: string): boolean {
    const domain = this.config.staffEmailDomain;
    return Boolean(domain) && normaliseEmail(email).endsWith(`@${domain}`);
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
  public async activateStaff(
    rawToken: string,
    password: string,
    client?: ClientContext
  ): Promise<{ tokens: GeneratedTokens; enrolmentToken: string }> {
    const passwordHash = await PasswordService.hash(password);
    const { user, enrolmentToken } = await this.prisma.$transaction(async (tx) => {
      const userId = await this.consumeEnrolmentToken(tx, rawToken, EnrolmentPurpose.ACTIVATE);
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } });
      await this.sessions.revokeAllInTx(tx, userId, 'STAFF_ACTIVATED');
      const token = await this.createEnrolmentToken(tx, userId, EnrolmentPurpose.MFA_ENROL);
      await this.audit(tx, userId, 'STAFF_ACTIVATED', userId);
      return { user: updated, enrolmentToken: token };
    });
    await this.publishTokenVersion(user.id, user.tokenVersion);
    return { tokens: await this.startSession(user, false, undefined, false, { client }), enrolmentToken };
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
    try {
      await this.beginPasswordAttempt(email, ctx.network);
    } catch (err) {
      loginsTotal.inc({ result: 'locked' });
      throw err;
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always run one Argon2 verification so response time doesn't reveal whether the email exists
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const isPasswordValid = await PasswordService.verify(hashToCheck, dto.password);

    if (!user || !user.isActive || !isPasswordValid) {
      loginsTotal.inc({ result: 'failure' });
      // After the response, and the same work whether or not the account exists: no timing signal
      this.runInBackground('record failed sign-in', () => this.afterFailedSignIn(email, ctx, user, isPasswordValid));
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }

    // Only revealed after a correct password, so it doesn't leak whether an email is a staff account.
    // Not a successful sign-in: the attempt isn't refunded and the network isn't remembered.
    try {
      this.assertStaffNetwork(user, ctx);
    } catch (err) {
      loginsTotal.inc({ result: 'blocked' });
      throw err;
    }

    await this.security.loginSucceeded(email, ctx.network);

    if (!user.isEmailVerified) {
      // Only revealed after a correct password, so it doesn't leak account existence
      loginsTotal.inc({ result: 'blocked' });
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address before signing in');
    }

    if (user.mfaEnabled) {
      const challengeToken = await this.security.createMfaChallenge(user.id, user.tokenVersion, this.config.mfaChallengeTtlSeconds);
      loginsTotal.inc({ result: 'mfa_challenge' });
      return { mfaRequired: true, challengeToken, expiresInSeconds: this.config.mfaChallengeTtlSeconds };
    }

    // tokenVersion as read BEFORE the password check: a reset committing meanwhile invalidates this login
    const tokens = await this.startSession(user, false, user.tokenVersion, false, { client: ctx, signIn: true });
    loginsTotal.inc({ result: 'success' });
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
  }

  /**
   * After a wrong password (or a sign-in to a disabled account): counts the account towards the address's
   * credential-stuffing window, bans the address at the edge once too many distinct accounts failed from it,
   * and records the failure in the account's security history.
   */
  private async afterFailedSignIn(email: string, ctx: LoginContext, user: User | null, passwordValid: boolean): Promise<void> {
    const ipKey = ctx.network;
    try {
      const distinct = await this.edge.recordFailedSignIn(ipKey, email);
      if (distinct > (this.config.credentialStuffingThreshold ?? 20)) await this.banForCredentialStuffing(ipKey, ctx, distinct);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Credential-stuffing check failed');
    }
    if (user) {
      const device = describeClient(ctx);
      await this.events.recordSafely({
        type: SecurityEventType.SIGN_IN_FAILED,
        userId: user.id,
        ip: device.ip,
        deviceLabel: device.deviceLabel,
        details: { reason: passwordValid ? 'ACCOUNT_DISABLED' : 'INVALID_PASSWORD' },
      });
    }
  }

  /** True for addresses that must never be banned automatically: unknown ones and the staff networks */
  private isBanExempt(ipKey: string, ip: string | undefined): boolean {
    if (ipKey === 'unknown') return true;
    if (this.config.staffNetworks && isAddressAllowed(this.config.staffNetworks, ip)) return true;
    const network = parseCidr(ipKey);
    return Boolean(network && (this.config.staffCidrs ?? []).some((staff) => cidrsOverlap(staff, network)));
  }

  private async banForCredentialStuffing(ipKey: string, ctx: LoginContext, distinctAccounts: number): Promise<void> {
    if (this.isBanExempt(ipKey, ctx.ip)) {
      logger.warn(
        { alert: 'CREDENTIAL_STUFFING_EXEMPT_NETWORK', ipMasked: maskIp(ctx.ip), distinctAccounts },
        'Credential-stuffing pattern from a staff or unknown address; not banned'
      );
      return;
    }
    const minutes = this.config.credentialStuffingBanMinutes ?? 30;
    const created = await this.edge.banIp(ipKey, minutes * 60, {
      reason: 'CREDENTIAL_STUFFING',
      bannedAt: new Date().toISOString(),
      source: 'auth-service',
      distinctAccounts,
    });
    if (!created) return; // already banned: recorded when the ban was created
    ipBansTotal.inc();
    logger.warn({ alert: 'CREDENTIAL_STUFFING_BAN', ipMasked: maskIp(ctx.ip), distinctAccounts, minutes }, 'Address banned at the edge for credential stuffing');
    await this.prisma.$transaction(async (tx) => {
      await this.events.record(tx, {
        type: SecurityEventType.IP_AUTO_BANNED,
        userId: null,
        ip: describeClient(ctx).ip,
        details: { reason: 'CREDENTIAL_STUFFING', distinctAccounts, banMinutes: minutes },
      });
      await this.audit(tx, null, 'IP_AUTO_BANNED', ipKey, { reason: 'CREDENTIAL_STUFFING', distinctAccounts, banMinutes: minutes });
    });
  }

  /**
   * Second login step: a valid TOTP code for the challenge's user. Attempts are counted atomically before
   * verification; codes are single-use; and a per-user failure budget (independent of the password) pauses
   * TOTP sign-in after repeated failures and alerts the user.
   */
  public async completeMfaLogin(challengeToken: string, code: string, ctx: LoginContext): Promise<AuthResponse> {
    const invalid = () => new UnauthorizedError('Invalid or expired verification code');
    const challenge = await this.security.consumeMfaChallengeAttempt(challengeToken);
    if (!challenge) throw invalid();
    const { userId } = challenge;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEnc) {
      await this.security.deleteMfaChallenge(challengeToken);
      throw invalid();
    }
    // The challenge proves the password; checked before the code so TOTP can't be tried off-network
    this.assertStaffNetwork(user, ctx);

    const discardChallenge = () => this.security.deleteMfaChallenge(challengeToken);
    let valid: boolean;
    try {
      valid = await this.checkTotp(user, user.mfaSecretEnc, code, discardChallenge, { context: 'SIGN_IN', client: ctx });
    } catch (err) {
      loginsTotal.inc({ result: 'locked' });
      throw err;
    }
    if (!valid) {
      loginsTotal.inc({ result: 'mfa_failure' });
      throw invalid();
    }

    await discardChallenge();
    // Bound to the token version at password time: a reset since then kills this half-finished login
    const tokens = await this.startSession(user, true, challenge.tokenVersion, true, { client: ctx, signIn: true });
    loginsTotal.inc({ result: 'success' });
    return { user: { id: user.id, email: user.email, role: user.role }, tokens };
  }

  /**
   * Checks a TOTP code within the user's failure budget, shared by sign-in, step-up and MFA disable. One
   * attempt is reserved BEFORE the code is verified, so concurrent guesses can't all pass a "not locked yet"
   * check; a correct code clears the budget, a wrong or replayed one keeps its reservation as a failure.
   * Returns false for a wrong code; throws 429 MFA_TEMPORARILY_LOCKED once the budget is spent.
   * `onLocked` runs when the budget is (or has just become) exhausted, e.g. to discard a login challenge.
   */
  private async checkTotp(
    user: User,
    secretEnc: string,
    code: string,
    onLocked?: () => Promise<void>,
    attempt: { context: 'SIGN_IN' | 'STEP_UP' | 'DISABLE'; client?: ClientContext } = { context: 'STEP_UP' }
  ): Promise<boolean> {
    const reservation = await this.security.reserveMfaAttempt(user.id);
    if (!reservation.allowed) {
      await onLocked?.();
      throw new HttpError(429, 'MFA_TEMPORARILY_LOCKED', 'Too many failed verification codes. Try again later.');
    }
    const step = verifyTotp(decryptSecret(secretEnc, user.id), code);
    if (step !== null && (await this.consumeTotpStep(user.id, step))) {
      await this.security.clearMfaFailures(user.id);
      return true;
    }
    if (reservation.last) {
      await onLocked?.();
      logger.warn({ userId: user.id, alert: 'MFA_BRUTE_FORCE' }, 'TOTP paused after repeated failures');
      this.runInBackground('send MFA locked email', () => this.mailer.send(mfaLockedEmail(user.email)).then(() => {}));
    }
    const device = describeClient(attempt.client);
    this.runInBackground('record MFA failure', () =>
      this.events.recordSafely({
        type: SecurityEventType.MFA_FAILED,
        userId: user.id,
        ip: device.ip,
        deviceLabel: attempt.client ? device.deviceLabel : null,
        details: { context: attempt.context, locked: reservation.last },
      })
    );
    return false;
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
  public async refreshToken(rawRefreshToken: string, client?: ClientContext): Promise<GeneratedTokens> {
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
      await this.sessions.touch(tx, {
        id: record.familyId,
        userId: record.userId,
        mfa: record.mfaAuthenticated,
        expiresAt: record.familyExpiresAt,
        device: describeClient(client),
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
        await this.sessions.revokeFamily(outcome.familyId, 'ACCOUNT_DISABLED', { client });
        throw new UnauthorizedError('Account is disabled');
      case 'reuse':
        // Token theft: kill the whole session family
        logger.warn({ alert: 'REFRESH_TOKEN_REUSE', ipMasked: maskIp(client?.ip) }, 'A rotated refresh token was presented again; session revoked');
        await this.sessions.revokeFamily(outcome.familyId, 'TOKEN_REUSE', { client });
        throw new UnauthorizedError(REUSE_MESSAGE);
    }
  }

  /**
   * Ends the session: revokes the refresh-token family and, if the caller presented a valid access
   * token, denylists it in Redis so it stops working immediately instead of at expiry.
   */
  public async logout(rawRefreshToken: string, accessToken?: AuthenticatedUser | null, client?: ClientContext): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (record && (!accessToken || record.userId === accessToken.id)) {
      await this.sessions.revokeFamily(record.familyId, 'LOGOUT', { client });
    }

    if (accessToken?.jti && accessToken.expiresAt) {
      await this.tokenState.revokeJti(accessToken.jti, accessToken.expiresAt - Math.floor(Date.now() / 1000));
    }
  }

  // ---------------------------------------------------------------------------
  // MFA enrolment (re-authentication required; staff also need a one-time enrolment token)
  // ---------------------------------------------------------------------------

  /**
   * Password re-check inside an authenticated session. Counted like a sign-in attempt (same per-account and
   * per-network lockout, counted before the check), so a stolen session can't be used to guess the password.
   * A wrong password is 403 INVALID_PASSWORD, never 401: clients treat a 401 on an authenticated request as
   * an expired session and would sign the user out over a typo.
   */
  private async reauthenticate(user: User, password: string, ctx: LoginContext, message = 'Password is incorrect'): Promise<void> {
    await this.beginPasswordAttempt(user.email, ctx.network);
    if (!(await PasswordService.verify(user.passwordHash, password))) {
      throw new HttpError(403, 'INVALID_PASSWORD', message);
    }
    await this.security.loginSucceeded(user.email, ctx.network);
  }

  /** Counts a password attempt BEFORE it is checked (atomic, so bursts can't exceed the limit); throws while locked */
  private async beginPasswordAttempt(email: string, network: string): Promise<void> {
    const attempt = await this.security.beginLoginAttempt(email, network);
    if (!attempt.locked) return;
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

  /** Starts (or restarts) enrolment: returns a new secret to load into an authenticator app */
  public async beginMfaSetup(
    actor: AuthenticatedUser,
    password: string,
    enrolmentToken: string | undefined,
    ctx: LoginContext
  ): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.requireActiveUser(actor.id);
    if (user.mfaEnabled) throw new ConflictError('MFA is already enabled for this account');
    await this.reauthenticate(user, password, ctx);
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
    const sessionId = actor.sessionId;
    if (!sessionId) throw new UnauthorizedError();

    const secret = decryptSecret(user.mfaPendingSecretEnc, user.id);
    const step = verifyTotp(secret, code);
    if (step === null) throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');

    const { updated, tokens } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      if (isStaffRole(user.role)) {
        if (!enrolmentToken) throw new HttpError(403, 'ENROLMENT_TOKEN_REQUIRED', 'Staff MFA enrolment requires a valid one-time enrolment token');
        await this.consumeEnrolmentToken(tx, enrolmentToken, EnrolmentPurpose.MFA_ENROL, user.id);
      }
      const current = await tx.refreshToken.findFirst({
        where: { userId: user.id, familyId: sessionId, isRevoked: false },
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
      // only through the new tokens issued here in the same family. Issued inside the transaction (under
      // the user row lock) so a password reset landing right after commit revokes them as well.
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      await this.sessions.revokeAllInTx(tx, user.id, 'MFA_ENABLED', sessionId);
      await this.sessions.markMfa(tx, sessionId);
      await this.audit(tx, user.id, 'MFA_ENABLED', user.id);
      // The code just verified is a fresh TOTP check; the factor-age rule still keeps a brand-new factor
      // from authorising high-risk actions in production
      const issued = await this.createTokensInFamily(
        tx,
        result,
        { familyId: sessionId, familyExpiresAt: current.familyExpiresAt, mfaAuthenticated: true },
        true
      );
      return { updated: result, tokens: issued };
    });

    await this.publishTokenVersion(updated.id, updated.tokenVersion);
    this.runInBackground('send MFA changed email', () =>
      this.mailer.send(mfaChangedEmail(updated.email, true)).then(() => {})
    );
    return tokens;
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
    if (!(await this.checkTotp(user, user.mfaSecretEnc, code, undefined, { context: 'STEP_UP' }))) {
      throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');
    }
    const session = await this.prisma.refreshToken.findFirst({ where: { userId: user.id, familyId: actor.sessionId, isRevoked: false } });
    if (!session) throw new UnauthorizedError('Your session is no longer valid');
    await this.audit(this.prisma, user.id, 'MFA_STEP_UP', user.id);
    return { accessToken: this.accessTokenFor(user, actor.sessionId, true, true), expiresInSeconds: this.tokenService.accessTokenTtlSeconds };
  }

  /**
   * Customers may turn MFA off with their password and a current code. Staff cannot: MFA is
   * mandatory for them and only a four-eyes administrative reset can clear it.
   */
  public async disableMfa(actor: AuthenticatedUser, password: string, code: string, ctx: LoginContext): Promise<void> {
    const user = await this.requireActiveUser(actor.id);
    if (isStaffRole(user.role)) {
      throw new ForbiddenError('MFA is mandatory for staff accounts');
    }
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new ConflictError('MFA is not enabled');
    await this.reauthenticate(user, password, ctx);
    // Same TOTP failure budget as sign-in and step-up
    if (!(await this.checkTotp(user, user.mfaSecretEnc, code, undefined, { context: 'DISABLE', client: ctx }))) {
      throw new HttpError(400, 'INVALID_MFA_CODE', 'The verification code is not valid');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaEnabledAt: null, mfaSecretEnc: null, mfaPendingSecretEnc: null, tokenVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      await this.sessions.revokeAllInTx(tx, user.id, 'MFA_DISABLED');
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
    await this.sessions.revokeAllInTx(tx, userId, 'MFA_RESET');
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
  public async resetPassword(rawToken: string, newPassword: string, client?: ClientContext): Promise<void> {
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
      await this.recordPasswordChanged(tx, token.userId, 'RESET', client);
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
    newPassword: string,
    ctx: LoginContext
  ): Promise<GeneratedTokens> {
    const existing = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!existing || !existing.isActive) {
      throw new UnauthorizedError();
    }
    await this.reauthenticate(existing, currentPassword, ctx, 'Current password is incorrect');
    if (await PasswordService.verify(existing.passwordHash, newPassword)) {
      throw new HttpError(400, 'PASSWORD_REUSED', 'The new password must be different from the current one');
    }

    const passwordHash = await PasswordService.hash(newPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await this.applyPasswordChange(tx, existing.id, passwordHash, {});
      await this.recordPasswordChanged(tx, existing.id, 'CHANGE', ctx);
      await this.audit(tx, existing.id, 'PASSWORD_CHANGED', existing.id);
      return updated;
    });
    await this.afterPasswordChange(user);
    return this.startSession(user, Boolean(actor.mfa), user.tokenVersion, false, { client: ctx });
  }

  private async recordPasswordChanged(tx: Tx, userId: string, via: 'CHANGE' | 'RESET', client?: ClientContext): Promise<void> {
    const device = describeClient(client);
    await this.events.record(tx, {
      type: SecurityEventType.PASSWORD_CHANGED,
      userId,
      ip: device.ip,
      deviceLabel: client ? device.deviceLabel : null,
      details: { via },
    });
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
    await this.sessions.revokeAllInTx(tx, userId, 'PASSWORD_CHANGED');
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
   * Staff user directory (BANK_ADMIN, SUPPORT): newest first, optionally by role and by `q` (email contains,
   * case-insensitive, or the exact id when `q` is a UUID). Only directory fields are ever read or returned,
   * never hashes or MFA secrets; every listing is audited with the ids it revealed.
   */
  public async listUsers(
    actor: AuthenticatedUser,
    filter: { role?: Role; q?: string; limit: number; offset: number }
  ): Promise<DirectoryUser[]> {
    const where: Prisma.UserWhereInput = filter.role ? { role: filter.role } : {};
    const q = filter.q?.trim();
    if (q) {
      const match: Prisma.UserWhereInput[] = [{ email: { contains: q, mode: 'insensitive' } }];
      if (UUID.test(q)) match.push({ id: q.toLowerCase() });
      where.OR = match;
    }
    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, email: true, role: true, isActive: true, isEmailVerified: true, mfaEnabled: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // id: a stable order across pages
      take: filter.limit,
      skip: filter.offset,
    });
    await this.audit(this.prisma, actor.id, 'ADMIN_USERS_LISTED', null, {
      role: filter.role ?? null,
      q: q || null,
      limit: filter.limit,
      offset: filter.offset,
      userIds: users.map((u) => u.id),
    });
    // Built field by field, so nothing beyond the directory fields can reach the response
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      isEmailVerified: u.isEmailVerified,
      mfaEnabled: u.mfaEnabled,
      createdAt: u.createdAt,
    }));
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
      await this.sessions.revokeAllInTx(tx, userId, 'ACCOUNT_DISABLED');
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
   * Mirrors token versions into Redis: every non-zero version (full pass), or only users changed since a
   * given time. Writes are pipelined per batch when the store supports it.
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
      if (this.tokenState.setTokenVersions) {
        await this.tokenState.setTokenVersions(batch.map((u) => ({ userId: u.id, tokenVersion: u.tokenVersion })));
      } else {
        for (const u of batch) await this.tokenState.setTokenVersion(u.id, u.tokenVersion);
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
   * Keeps Redis in step with the DB without delaying startup: a full pass runs in the background (retried
   * every interval until it succeeds), then each pass syncs the users changed since shortly before the
   * previous successful one, which repairs any write that failed (e.g. a Redis blip during a reset). Passes
   * never overlap. Serving before the first pass is safe: Redis is persistent and normally already current,
   * and the other services check it whether or not auth-service is up. Returns a function that stops it.
   */
  public startTokenVersionSync(intervalMs = 30_000): () => void {
    let lastSuccessStart: number | null = null;
    let running = false;
    const pass = async () => {
      if (running) return;
      running = true;
      const startedAt = Date.now();
      const full = lastSuccessStart === null;
      try {
        const synced = await this.syncTokenVersions(full ? undefined : new Date(lastSuccessStart! - this.syncLookbackMs()));
        if (full) logger.info({ synced }, 'Token versions mirrored to Redis');
        lastSuccessStart = startedAt;
      } catch (err) {
        logger.warn({ err, full }, 'Token version sync failed; retrying on the next interval');
      } finally {
        running = false;
      }
    };
    void pass();
    const timer = setInterval(() => void pass(), intervalMs);
    return () => clearInterval(timer);
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

  /** Staff sign in only from STAFF_ALLOWED_CIDRS (every service refuses staff tokens from elsewhere too) */
  private assertStaffNetwork(user: User, ctx: LoginContext): void {
    const networks = this.config.staffNetworks;
    if (!networks || !isStaffRole(user.role) || isAddressAllowed(networks, ctx.ip)) return;
    logger.warn({ userId: user.id, role: user.role, alert: 'STAFF_LOGIN_OFF_NETWORK' }, 'Staff sign-in from a non-allowed network');
    throw staffNetworkError('Staff sign-in is only available from the staff network');
  }

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

  /** Appends to the hash-chained audit log, inside `tx` (or in a transaction of its own for the root client) */
  public async audit(
    tx: Client,
    actorId: string | null,
    action: string,
    targetId: string | null,
    details?: Record<string, unknown>
  ): Promise<void> {
    await writeAudit(tx, { actorId, action, targetId, details });
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
  private async startSession(
    user: User,
    mfaAuthenticated: boolean,
    expectedVersion?: number,
    stepUp = false,
    options: { client?: ClientContext; signIn?: boolean } = {}
  ): Promise<GeneratedTokens> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!fresh.isActive || (expectedVersion !== undefined && fresh.tokenVersion !== expectedVersion)) {
        throw new UnauthorizedError('Your credentials changed while signing in. Please sign in again.');
      }
      const family = {
        familyId: crypto.randomUUID(),
        familyExpiresAt: new Date(Date.now() + this.config.sessionMaxDays * 86400_000),
        mfaAuthenticated,
      };
      const tokens = await this.createTokensInFamily(tx, fresh, family, stepUp);

      const device = describeClient(options.client);
      // The account's very first session is never a "new device" (nor is the first one after this feature
      // shipped, for accounts that have no device history yet)
      const firstSession = !fresh.firstSignInAt;
      if (firstSession) await tx.user.updateMany({ where: { id: fresh.id, firstSignInAt: null }, data: { firstSignInAt: new Date() } });
      const newDevice = Boolean(options.signIn) && !firstSession && !(await this.sessions.isKnownDevice(tx, fresh.id, device));
      await this.sessions.create(tx, { id: family.familyId, userId: fresh.id, mfa: mfaAuthenticated, expiresAt: family.familyExpiresAt, device });

      if (options.signIn) {
        const event = { userId: fresh.id, ip: device.ip, deviceLabel: device.deviceLabel };
        await this.events.record(tx, { ...event, type: SecurityEventType.SIGN_IN_SUCCEEDED, details: { mfa: mfaAuthenticated, newDevice } });
        if (newDevice) {
          await this.events.record(tx, { ...event, type: SecurityEventType.NEW_DEVICE, details: { sessionId: family.familyId } });
          await this.stageNewDeviceLogin(tx, fresh, device.deviceLabel, maskIp(device.ip));
        }
      }
      return tokens;
    });
  }

  /** security.new_device_login.v1 (notification-service emails the account holder) */
  private async stageNewDeviceLogin(tx: Tx, user: User, deviceLabel: string, ipMasked: string | null): Promise<void> {
    const at = new Date().toISOString();
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'USER',
        aggregateId: user.id,
        eventType: 'security.new_device_login.v1',
        payload: {
          eventId: crypto.randomUUID(),
          eventType: 'security.new_device_login.v1',
          timestamp: at,
          userId: user.id,
          email: user.email,
          deviceLabel,
          ipMasked,
          at,
        },
      },
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
      refreshExpiresAt: expiresAt,
    };
  }
}
