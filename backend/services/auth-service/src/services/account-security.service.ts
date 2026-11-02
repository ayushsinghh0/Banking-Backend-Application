import { PrismaClient, SecurityEventType } from '../../generated/client';
import { AuthenticatedUser, ChainVerification, HttpError, NotFoundError } from '@banksphere/common';
import { AuthService } from './auth.service';
import { ClientContext, SessionView } from './sessions';
import { SecurityEventView } from './security-events';
import { IpRuleService } from './ip-rules.service';
import { verifyAuditLog } from './audit';

/**
 * The account-security API (design section 9): a user's own sessions and sign-in history, the staff views of
 * any user's, and audit-chain verification. Staff reads of a customer's sessions and history are audited,
 * like every other staff read of customer data.
 */
export class AccountSecurityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: AuthService,
    public readonly ipRules: IpRuleService
  ) {}

  public listOwnSessions(actor: AuthenticatedUser): Promise<SessionView[]> {
    return this.auth.sessions.listActive(actor.id, actor.sessionId);
  }

  /** Signs one of the caller's own sessions out (any of them, including the current one) */
  public async revokeOwnSession(actor: AuthenticatedUser, sessionId: string, client: ClientContext): Promise<{ id: string; revoked: boolean }> {
    const session = await this.prisma.userSession.findFirst({ where: { id: sessionId, userId: actor.id }, select: { revokedAt: true } });
    if (!session) throw new NotFoundError('Session not found');
    if (session.revokedAt) return { id: sessionId, revoked: false };
    const revoked = await this.auth.sessions.revokeFamily(sessionId, 'USER_REVOKED', { userId: actor.id, client });
    return { id: sessionId, revoked };
  }

  public async revokeOtherSessions(actor: AuthenticatedUser, client: ClientContext): Promise<{ revoked: number }> {
    if (!actor.sessionId) throw new HttpError(400, 'NO_CURRENT_SESSION', 'This access token does not belong to a session');
    return { revoked: await this.auth.sessions.revokeOthers(actor.id, actor.sessionId, client) };
  }

  public listOwnEvents(actor: AuthenticatedUser, limit: number): Promise<SecurityEventView[]> {
    return this.auth.events.listForUser(actor.id, limit);
  }

  public async adminListSessions(admin: AuthenticatedUser, userId: string): Promise<SessionView[]> {
    await this.requireUser(userId);
    const sessions = await this.auth.sessions.listActive(userId);
    await this.auth.audit(this.prisma, admin.id, 'ADMIN_SESSIONS_VIEWED', userId, { sessions: sessions.length });
    return sessions;
  }

  public async adminRevokeSession(
    admin: AuthenticatedUser,
    userId: string,
    sessionId: string,
    client: ClientContext
  ): Promise<{ id: string; revoked: boolean }> {
    const session = await this.prisma.userSession.findFirst({ where: { id: sessionId, userId }, select: { revokedAt: true } });
    if (!session) throw new NotFoundError('Session not found');
    if (session.revokedAt) return { id: sessionId, revoked: false };
    const revoked = await this.auth.sessions.revokeFamily(sessionId, 'ADMIN_REVOKED', {
      userId,
      client,
      // The audit row commits with the revocation, or neither happens
      inTransaction: (tx) => this.auth.audit(tx, admin.id, 'ADMIN_SESSION_REVOKED', userId, { sessionId }),
    });
    return { id: sessionId, revoked };
  }

  public async adminListEvents(
    admin: AuthenticatedUser,
    filter: { type?: SecurityEventType; userId?: string; limit: number; cursor?: string }
  ): Promise<{ items: SecurityEventView[]; nextCursor: string | null }> {
    const page = await this.auth.events.list(filter);
    await this.auth.audit(this.prisma, admin.id, 'ADMIN_SECURITY_EVENTS_VIEWED', filter.userId ?? null, {
      type: filter.type ?? null,
      limit: filter.limit,
      paged: Boolean(filter.cursor),
      events: page.items.length,
    });
    return page;
  }

  /** Re-walks the audit chain; the check itself is audited with its outcome */
  public async verifyAudit(admin: AuthenticatedUser): Promise<ChainVerification> {
    const result = await verifyAuditLog(this.prisma);
    await this.auth.audit(this.prisma, admin.id, 'AUDIT_CHAIN_VERIFIED', null, {
      ok: result.ok,
      checked: result.checked,
      brokenAt: result.brokenAt ?? null,
    });
    return result;
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError('User not found');
  }
}
