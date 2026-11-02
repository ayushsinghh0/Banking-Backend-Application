import { IpRule, PrismaClient } from '../../generated/client';
import { AuthenticatedUser, ConflictError, HttpError, NotFoundError, logger } from '@banksphere/common';
import { Cidr, cidrContains, cidrsOverlap, isIpKey, isIpv4Mapped, maskIpKey, parseCidr, parseCidrList } from './ip-address';
import { EdgeSecurityStore } from './edge-security.store';
import { appendAudit, writeAudit } from './audit';

/**
 * Edge IP deny rules and bans (design section 9). The database is the source of truth; every change is
 * mirrored to the edge Redis for the gateway right away, and a leased job re-mirrors every minute (the edge
 * Redis may evict). Every change is audited.
 */
export const MAX_ACTIVE_RULES = 1000;
export const MIN_IPV4_PREFIX = 8;
export const MIN_IPV6_PREFIX = 32;
export const MIN_RULE_MINUTES = 5;
export const MAX_RULE_MINUTES = 365 * 24 * 60;

export interface IpRuleView {
  id: string;
  cidr: string;
  action: 'DENY';
  reason: string;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface IpBanView {
  ipKey: string;
  ipMasked: string | null;
  reason: string | null;
  bannedAt: string | null;
  expiresAt: string | null;
}

export interface NewIpRule {
  cidr: string;
  reason: string;
  expiresInMinutes?: number;
}

const invalid = (code: string, message: string) => new HttpError(400, code, message);

const view = (rule: IpRule): IpRuleView => ({
  id: rule.id,
  cidr: rule.cidr,
  action: 'DENY',
  reason: rule.reason,
  expiresAt: rule.expiresAt,
  createdBy: rule.createdBy,
  createdAt: rule.createdAt,
});

export class IpRuleService {
  private readonly staffCidrs: Cidr[];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly edge: EdgeSecurityStore,
    options: { staffCidrs?: Cidr[]; now?: () => number } = {}
  ) {
    this.staffCidrs = options.staffCidrs ?? parseCidrList(process.env.STAFF_ALLOWED_CIDRS);
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  private activeWhere() {
    const now = new Date(this.now());
    return { removedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  }

  public async list(): Promise<IpRuleView[]> {
    const rules = await this.prisma.ipRule.findMany({ where: this.activeWhere(), orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: MAX_ACTIVE_RULES });
    return rules.map(view);
  }

  /**
   * Validates a rule: a parseable IPv4/IPv6 network no wider than /8 (IPv4) or /32 (IPv6), not written as an
   * IPv4-mapped IPv6 network, not overlapping STAFF_ALLOWED_CIDRS (a rule must never lock staff out of the
   * staff APIs that remove rules), and not containing the caller's own address. Returns the canonical network.
   */
  public validate(input: NewIpRule, callerIp: string | undefined): { cidr: Cidr; reason: string; expiresAt: Date | null } {
    const cidr = parseCidr(input.cidr);
    if (!cidr) throw invalid('INVALID_CIDR', 'Enter an IPv4 or IPv6 address or network, e.g. 203.0.113.0/24');
    if (isIpv4Mapped(cidr)) throw invalid('INVALID_CIDR', 'Write IPv4 networks in IPv4 form, e.g. 203.0.113.0/24');
    if (cidr.family === 4 && cidr.prefix < MIN_IPV4_PREFIX) throw invalid('RULE_TOO_WIDE', `IPv4 rules can be at most a /${MIN_IPV4_PREFIX}`);
    if (cidr.family === 6 && cidr.prefix < MIN_IPV6_PREFIX) throw invalid('RULE_TOO_WIDE', `IPv6 rules can be at most a /${MIN_IPV6_PREFIX}`);
    if (this.staffCidrs.some((staff) => cidrsOverlap(staff, cidr))) {
      throw invalid('RULE_OVERLAPS_STAFF_NETWORK', 'This network overlaps the staff networks and cannot be blocked');
    }
    if (cidrContains(cidr, callerIp)) throw invalid('RULE_BLOCKS_YOU', 'This rule would block your own address');

    // eslint-disable-next-line no-control-regex
    const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (reason.length < 5 || reason.length > 200) throw invalid('INVALID_REASON', 'The reason must be 5 to 200 characters');

    const minutes = input.expiresInMinutes;
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < MIN_RULE_MINUTES || minutes > MAX_RULE_MINUTES)) {
      throw invalid('INVALID_EXPIRY', `A rule lasts ${MIN_RULE_MINUTES} minutes to 365 days, or until it is removed`);
    }
    return { cidr, reason, expiresAt: minutes === undefined ? null : new Date(this.now() + minutes * 60_000) };
  }

  public async create(actor: AuthenticatedUser, input: NewIpRule, callerIp: string | undefined): Promise<IpRuleView> {
    const { cidr, reason, expiresAt } = this.validate(input, callerIp);
    const rule = await this.prisma.$transaction(async (tx) => {
      // Serialises rule changes, so the active-rule cap and the duplicate check hold under concurrency
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth-ip-rules', 0))::text`;
      const active = await tx.ipRule.findMany({ where: this.activeWhere(), select: { cidr: true } });
      if (active.length >= MAX_ACTIVE_RULES) {
        throw new ConflictError(`There are already ${MAX_ACTIVE_RULES} active rules; remove some first`);
      }
      if (active.some((r) => r.cidr === cidr.text)) throw new ConflictError(`${cidr.text} is already blocked`);
      const created = await tx.ipRule.create({ data: { cidr: cidr.text, reason, expiresAt, createdBy: actor.id } });
      await appendAudit(tx, {
        actorId: actor.id,
        action: 'IP_RULE_CREATED',
        targetId: created.id,
        details: { cidr: created.cidr, reason, expiresAt: expiresAt?.toISOString() ?? null },
      });
      return created;
    });
    await this.mirrorSafely();
    return view(rule);
  }

  public async remove(actor: AuthenticatedUser, ruleId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth-ip-rules', 0))::text`;
      const { count } = await tx.ipRule.updateMany({
        where: { id: ruleId, ...this.activeWhere() },
        data: { removedAt: new Date(this.now()), removedBy: actor.id },
      });
      if (count !== 1) throw new NotFoundError('No active rule with this id');
      await appendAudit(tx, { actorId: actor.id, action: 'IP_RULE_REMOVED', targetId: ruleId });
    });
    await this.mirrorSafely();
  }

  /**
   * Writes the active rules to the edge Redis. Runs under the same lock as rule changes and reads inside it,
   * so two writers can never leave an older rule set in Redis after a newer one.
   */
  public async syncMirror(): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth-ip-rules', 0))::text`;
      const rules = await tx.ipRule.findMany({ where: this.activeWhere(), orderBy: { createdAt: 'asc' }, take: MAX_ACTIVE_RULES });
      return this.edge.mirrorIpRules(rules.map((r) => ({ id: r.id, cidr: r.cidr, expiresAt: r.expiresAt, reason: r.reason })));
    });
  }

  /** After a change: the rule is committed either way, and the periodic sync repairs a failed mirror within a minute */
  private async mirrorSafely(): Promise<void> {
    try {
      await this.syncMirror();
    } catch (err) {
      logger.error({ err, alert: 'IP_RULES_MIRROR_FAILED' }, 'Could not mirror IP rules to the edge Redis; the periodic sync will retry');
    }
  }

  public async listBans(): Promise<{ bans: IpBanView[]; complete: boolean }> {
    const { bans, complete } = await this.edge.listBans(500);
    const now = this.now();
    return {
      complete,
      bans: bans.map((ban) => ({
        ipKey: ban.ipKey,
        ipMasked: maskIpKey(ban.ipKey),
        reason: typeof ban.info?.reason === 'string' ? ban.info.reason : null,
        bannedAt: typeof ban.info?.bannedAt === 'string' ? ban.info.bannedAt : null,
        expiresAt: ban.ttlMs === null ? null : new Date(now + ban.ttlMs).toISOString(),
      })),
    };
  }

  public async liftBan(actor: AuthenticatedUser, ipKey: string): Promise<void> {
    if (!isIpKey(ipKey)) throw invalid('INVALID_IP_KEY', 'Not a ban key');
    if (!(await this.edge.liftBan(ipKey))) throw new NotFoundError('No active ban for this address');
    await writeAudit(this.prisma, { actorId: actor.id, action: 'IP_BAN_LIFTED', targetId: ipKey });
  }
}
