import net from 'net';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis from 'ioredis';
import { counter, gauge, logger, normaliseClientIp } from '@banksphere/common';

/**
 * IP deny rules, written by auth-service (the database is the source of truth) and mirrored to the edge Redis:
 *   edge:ip-rules           hash  rule id -> JSON { cidr, expiresAt: ISO-8601 | null, reason }
 *   edge:ip-rules:version   string, changed on every write
 * Every replica polls the version (one GET every few seconds) and recompiles its in-memory net.BlockList only
 * when it changes, so the per-request check is a local lookup.
 */
export const IP_RULES_KEY = 'edge:ip-rules';
export const IP_RULES_VERSION_KEY = 'edge:ip-rules:version';

export interface IpRuleSource {
  readVersion(): Promise<string | null>;
  readRules(): Promise<Record<string, string>>;
}

export class RedisIpRuleSource implements IpRuleSource {
  constructor(private readonly redis: Redis) {}

  public readVersion(): Promise<string | null> {
    return this.redis.get(IP_RULES_VERSION_KEY);
  }

  public readRules(): Promise<Record<string, string>> {
    return this.redis.hgetall(IP_RULES_KEY);
  }
}

interface ParsedRule {
  id: string;
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
  expiresAt: number | null;
}

const blocked = counter('gateway_ip_blocked_total', 'Requests refused because the client address is blocked', ['reason']);
const activeRules = gauge('gateway_ip_rules_active', 'IP deny rules currently enforced by this replica');

/** "203.0.113.0/24", "2001:db8::/32" or a bare address; null if malformed */
export function parseRuleCidr(cidr: unknown): Pick<ParsedRule, 'address' | 'prefix' | 'family'> | null {
  if (typeof cidr !== 'string') return null;
  const [address, prefixText, ...rest] = cidr.trim().split('/');
  if (rest.length) return null;
  const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
  if (!family) return null;
  const max = family === 'ipv4' ? 32 : 128;
  if (prefixText === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) return null;
  return { address, prefix: Number(prefixText), family };
}

export class IpDenyList {
  private list = new net.BlockList();
  private rules: ParsedRule[] = [];
  private version: string | null = null;
  private nextExpiry = Infinity;
  private refreshing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly source: IpRuleSource,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The version currently enforced (null before the first successful load) */
  public get loadedVersion(): string | null {
    return this.version;
  }

  public get size(): number {
    return this.rules.length;
  }

  public isBlocked(ip: string | undefined): boolean {
    if (!this.rules.length) return false;
    const address = normaliseClientIp(ip);
    if (net.isIPv4(address)) return this.list.check(address, 'ipv4');
    if (net.isIPv6(address)) return this.list.check(address, 'ipv6');
    return false;
  }

  /**
   * Reloads the rules if the version changed, and drops rules whose expiry has passed. A missing version
   * (the evictable edge Redis dropped it) or a Redis error keeps the rules already loaded: auth-service
   * re-mirrors them within a minute. Concurrent calls share one refresh.
   */
  public refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const version = await this.source.readVersion();
    if (version !== null && version !== this.version) {
      const raw = await this.source.readRules();
      this.rules = this.parse(raw);
      this.version = version;
      this.compile();
      logger.info({ version, rules: this.rules.length }, 'IP deny rules loaded');
      return;
    }
    if (this.now() >= this.nextExpiry) this.compile();
  }

  /** Polls every `intervalMs`; returns a function that stops it */
  public start(intervalMs = 5_000): () => void {
    const tick = () =>
      this.refresh().catch((err) => logger.warn({ err: (err as Error).message }, 'IP deny rules refresh failed; keeping the rules already loaded'));
    void tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private parse(raw: Record<string, string>): ParsedRule[] {
    const now = this.now();
    const rules: ParsedRule[] = [];
    for (const [id, json] of Object.entries(raw)) {
      let value: { cidr?: unknown; expiresAt?: unknown };
      try {
        value = JSON.parse(json);
      } catch {
        logger.warn({ ruleId: id }, 'Skipping malformed IP rule (not JSON)');
        continue;
      }
      const cidr = parseRuleCidr(value?.cidr);
      const expiresAt = value?.expiresAt === null || value?.expiresAt === undefined ? null : Date.parse(String(value.expiresAt));
      if (!cidr || Number.isNaN(expiresAt)) {
        logger.warn({ ruleId: id }, 'Skipping malformed IP rule');
        continue;
      }
      if (expiresAt !== null && expiresAt <= now) continue;
      rules.push({ id, ...cidr, expiresAt });
    }
    return rules;
  }

  /** Builds a fresh BlockList from the unexpired rules (swapped in whole, so a check never sees half a list) */
  private compile(): void {
    const now = this.now();
    this.rules = this.rules.filter((r) => r.expiresAt === null || r.expiresAt > now);
    const list = new net.BlockList();
    for (const rule of this.rules) {
      if (rule.prefix === (rule.family === 'ipv4' ? 32 : 128)) list.addAddress(rule.address, rule.family);
      else list.addSubnet(rule.address, rule.prefix, rule.family);
    }
    this.list = list;
    this.nextExpiry = Math.min(Infinity, ...this.rules.map((r) => r.expiresAt ?? Infinity));
    activeRules.set(this.rules.length);
  }
}

/** 403 IP_BLOCKED for addresses inside a deny rule */
export function ipRulesMiddleware(denyList: IpDenyList): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!denyList.isBlocked(req.ip)) return next();
    blocked.inc({ reason: 'rule' });
    req.log?.debug({ path: req.path }, 'Request from a denied network');
    res.status(403).json({
      error: { code: 'IP_BLOCKED', message: 'Access from your network is blocked', correlationId: req.correlationId },
    });
  };
}
