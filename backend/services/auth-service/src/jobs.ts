import { acquireJobLease, logger } from '@banksphere/common';
import { PrismaClient } from '../generated/client';
import { AuthService } from './services/auth.service';
import { IpRuleService } from './services/ip-rules.service';

export interface SecurityJobOptions {
  /** IP rules mirror re-sync (the edge Redis may evict it; the database is the source of truth) */
  ipRulesSyncMs?: number;
  /** Retention: security events older than 180 days, sessions ended more than 90 days ago */
  retentionMs?: number;
}

/**
 * Periodic account-security jobs, each run by one replica at a time (job lease). Runs never overlap on a
 * replica; a failed run is logged and retried on the next tick. Returns a function that stops them.
 */
export function startSecurityJobs(
  prisma: PrismaClient,
  auth: AuthService,
  ipRules: IpRuleService,
  options: SecurityJobOptions = {}
): () => void {
  const syncMs = options.ipRulesSyncMs ?? 60_000;
  const retentionMs = options.retentionMs ?? 3_600_000;

  const leased = (name: string, leaseSeconds: number, work: () => Promise<void>) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        if (await acquireJobLease(prisma, name, leaseSeconds)) await work();
      } catch (err) {
        logger.warn({ err, job: name }, 'Account-security job failed; retrying on the next tick');
      } finally {
        running = false;
      }
    };
  };

  const syncIpRules = leased('auth-ip-rules-sync', Math.max(1, Math.floor((syncMs * 0.9) / 1000)), async () => {
    if (await ipRules.syncMirror()) logger.info('IP rules re-mirrored to the edge Redis');
  });
  const retention = leased('auth-security-retention', Math.max(1, Math.floor((retentionMs * 0.9) / 1000)), async () => {
    const events = await auth.events.purgeExpired();
    const sessions = await auth.sessions.purgeStale();
    if (events || sessions) logger.info({ events, sessions }, 'Account-security retention purge');
  });

  void syncIpRules();
  const timers = [setInterval(() => void syncIpRules(), syncMs), setInterval(() => void retention(), retentionMs)];
  timers.forEach((t) => t.unref());
  return () => timers.forEach((t) => clearInterval(t));
}
