import { Prisma, PrismaClient, SecurityEventType } from '../../generated/client';
import { counter, logger, TokenStateStore } from '@banksphere/common';
import { cleanUserAgent, parseUserAgent } from './user-agent';
import { maskIp, networkOf } from './ip-address';
import { SecurityEvents } from './security-events';

/**
 * Sessions and devices (design section 9). A session is a refresh-token family: it starts at sign-in, rotates
 * on every refresh and ends on logout, revocation, reuse detection or a credential change. user_sessions
 * describes each family for the account holder (device, network, when it was last used) and remembers which
 * devices a user has signed in from, for new-device alerts.
 */
export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

export interface DeviceInfo {
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string;
  browser: string;
  os: string;
  /** /24 (IPv4) or /48 (IPv6) of the address: the "same network" of the new-device rule */
  network: string | null;
}

export type SessionRevokeReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'USER_REVOKED_OTHERS'
  | 'ADMIN_REVOKED'
  | 'TOKEN_REUSE'
  | 'ACCOUNT_DISABLED'
  | 'PASSWORD_CHANGED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'MFA_RESET'
  | 'STAFF_ACTIVATED';

export interface SessionView {
  id: string;
  current: boolean;
  deviceLabel: string;
  ipMasked: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  mfa: boolean;
}

export interface NewSession {
  id: string;
  userId: string;
  mfa: boolean;
  expiresAt: Date;
  device: DeviceInfo;
}

type Tx = Prisma.TransactionClient;

/** Last-seen writes are throttled: at most one per session per minute */
export const TOUCH_INTERVAL_MS = 60_000;
/** A device counts as known for this long after it was last used (new-device rule) */
export const KNOWN_DEVICE_DAYS = 90;
/** Ended sessions are kept this long after their absolute expiry (the new-device rule looks back 90 days) */
const SESSION_RETENTION_DAYS = 90;

const revokedTotal = counter('auth_sessions_revoked_total', 'Sessions ended other than by expiry', ['reason']);

export function describeClient(client: ClientContext | undefined): DeviceInfo {
  const userAgent = cleanUserAgent(client?.userAgent);
  const parsed = parseUserAgent(userAgent);
  const ip = client?.ip ? client.ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') : null;
  return { ip, userAgent, deviceLabel: parsed.label, browser: parsed.browser, os: parsed.os, network: networkOf(ip) };
}

export interface SessionServiceDeps {
  prisma: PrismaClient;
  tokenState: TokenStateStore;
  events: SecurityEvents;
  /** Access tokens of a revoked session are denylisted this long (their remaining lifetime at most) */
  accessTokenTtlSeconds: number;
  /** A session whose refresh token has gone unused this long can no longer be resumed */
  refreshTokenTtlMs: number;
  now?: () => number;
}

export class SessionService {
  private readonly prisma: PrismaClient;
  private readonly tokenState: TokenStateStore;
  private readonly events: SecurityEvents;
  private readonly now: () => number;

  constructor(private readonly deps: SessionServiceDeps) {
    this.prisma = deps.prisma;
    this.tokenState = deps.tokenState;
    this.events = deps.events;
    this.now = deps.now ?? Date.now;
  }

  public async create(tx: Tx, session: NewSession): Promise<void> {
    const now = new Date(this.now());
    await tx.userSession.create({
      data: {
        id: session.id,
        userId: session.userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: session.expiresAt,
        firstIp: session.device.ip,
        lastIp: session.device.ip,
        userAgent: session.device.userAgent,
        deviceLabel: session.device.deviceLabel,
        browser: session.device.browser,
        os: session.device.os,
        network: session.device.network,
        mfa: session.mfa,
      },
    });
  }

  /**
   * Records use of a session on refresh, at most once a minute (a conditional update writes nothing when the
   * session was seen within the last minute). Families from before sessions were recorded get their row now.
   */
  public async touch(tx: Tx, session: NewSession): Promise<void> {
    const now = this.now();
    const touched = await tx.userSession.updateMany({
      where: { id: session.id, lastSeenAt: { lt: new Date(now - TOUCH_INTERVAL_MS) } },
      data: { lastSeenAt: new Date(now), ...(session.device.ip ? { lastIp: session.device.ip } : {}) },
    });
    if (touched.count > 0) return;
    const existing = await tx.userSession.findUnique({ where: { id: session.id }, select: { id: true } });
    if (!existing) await this.create(tx, session);
  }

  /**
   * New-device rule: a sign-in is from a known device when the user has used the same browser family on the
   * same OS family from the same network (/24, /48) within the last 90 days. Call before creating the new
   * session's row.
   */
  public async isKnownDevice(tx: Tx, userId: string, device: DeviceInfo): Promise<boolean> {
    const seen = await tx.userSession.findFirst({
      where: {
        userId,
        browser: device.browser,
        os: device.os,
        network: device.network,
        lastSeenAt: { gte: new Date(this.now() - KNOWN_DEVICE_DAYS * 86_400_000) },
      },
      select: { id: true },
    });
    return Boolean(seen);
  }

  /** The session continues with a second factor (MFA enrolment upgrades it in place) */
  public async markMfa(tx: Tx, sessionId: string): Promise<void> {
    await tx.userSession.updateMany({ where: { id: sessionId }, data: { mfa: true } });
  }

  /**
   * Marks every open session of the user ended (credential changes, disable). The caller revokes the refresh
   * tokens in the same transaction and bumps the token version, which kills the access tokens.
   */
  public async revokeAllInTx(tx: Tx, userId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    const { count } = await tx.userSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(this.now()), revokedReason: reason },
    });
    if (count) revokedTotal.inc({ reason }, count);
    return count;
  }

  /**
   * Ends one session: its refresh tokens, its row, and every access token issued in it (session denylist in
   * the token-state store, as long as an access token can live). `userId` scopes the revocation to one user's
   * sessions (user and admin revocations); false means there was no open session to end.
   */
  public async revokeFamily(
    familyId: string,
    reason: SessionRevokeReason,
    options: { userId?: string; client?: ClientContext; inTransaction?: (tx: Tx) => Promise<void> } = {}
  ): Promise<boolean> {
    const scope = options.userId ? { userId: options.userId } : {};
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { familyId, ...scope }, data: { isRevoked: true } });
      const [session] = await tx.userSession.findMany({
        where: { id: familyId, revokedAt: null, ...scope },
        select: { userId: true, deviceLabel: true },
      });
      if (session) {
        await tx.userSession.updateMany({ where: { id: familyId, revokedAt: null }, data: { revokedAt: new Date(this.now()), revokedReason: reason } });
        // deviceLabel: the session that ended; ip: the request that ended it (for reuse, possibly the thief)
        await this.events.record(tx, {
          type: SecurityEventType.SESSION_REVOKED,
          userId: session.userId,
          ip: describeClient(options.client).ip,
          deviceLabel: session.deviceLabel,
          details: { reason, sessionId: familyId },
        });
      }
      await options.inTransaction?.(tx);
      return Boolean(session);
    });
    if (revoked) revokedTotal.inc({ reason });
    await this.denylist([familyId]);
    return revoked;
  }

  /** "Sign out everywhere else": every session of the user except the current one. Returns how many were live. */
  public async revokeOthers(userId: string, currentSessionId: string, client?: ClientContext): Promise<number> {
    const others = { not: currentSessionId };
    const { families, live } = await this.prisma.$transaction(async (tx) => {
      const liveFamilies = await tx.refreshToken.findMany({
        where: { userId, isRevoked: false, familyId: others },
        select: { familyId: true },
        distinct: ['familyId'],
      });
      const openSessions = await tx.userSession.findMany({ where: { userId, revokedAt: null, id: others }, select: { id: true } });
      await tx.refreshToken.updateMany({ where: { userId, isRevoked: false, familyId: others }, data: { isRevoked: true } });
      await this.revokeAllInTx(tx, userId, 'USER_REVOKED_OTHERS', currentSessionId);
      const all = [...new Set([...liveFamilies.map((f) => f.familyId), ...openSessions.map((s) => s.id)])];
      if (all.length) {
        const device = describeClient(client);
        await this.events.record(tx, {
          type: SecurityEventType.SESSION_REVOKED,
          userId,
          ip: device.ip,
          deviceLabel: device.deviceLabel,
          details: { reason: 'USER_REVOKED_OTHERS', count: liveFamilies.length },
        });
      }
      return { families: all, live: liveFamilies.length };
    });
    await this.denylist(families);
    return live;
  }

  /** Sessions that can still be used: not revoked, within their absolute lifetime and their idle timeout */
  public async listActive(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const now = this.now();
    const rows = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date(now) },
        lastSeenAt: { gt: new Date(now - this.deps.refreshTokenTtlMs) },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    const views = rows.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      deviceLabel: row.deviceLabel,
      ipMasked: maskIp(row.lastIp ?? row.firstIp),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      mfa: row.mfa,
    }));
    // The session making the request first
    return [...views.filter((v) => v.current), ...views.filter((v) => !v.current)];
  }

  /** Retention: rows of sessions that ended (absolute expiry) more than 90 days ago, in short batches */
  public async purgeStale(budgetMs = 60_000, batchSize = 5_000): Promise<number> {
    const started = Date.now();
    let deleted = 0;
    for (;;) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM user_sessions WHERE id IN (
          SELECT id FROM user_sessions
          WHERE expires_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${SESSION_RETENTION_DAYS})
          LIMIT ${batchSize}
        )`;
      deleted += count;
      if (count < batchSize || Date.now() - started > budgetMs) return deleted;
    }
  }

  private async denylist(familyIds: string[]): Promise<void> {
    await Promise.all(
      familyIds.map(async (familyId) => {
        try {
          await this.tokenState.revokeSession(familyId, this.deps.accessTokenTtlSeconds);
        } catch (err) {
          // The refresh tokens are dead; outstanding access tokens then expire on their own within minutes
          logger.error({ err, alert: 'SESSION_DENYLIST_FAILED' }, 'Could not denylist the revoked session in Redis');
        }
      })
    );
  }
}
