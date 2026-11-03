import crypto from 'crypto';
import { ConsoleMailer, InMemoryTokenStateStore, generateJwtKeyPair } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { startSecurityJobs } from '../src/jobs';
import { AuthService } from '../src/services/auth.service';
import { TokenService } from '../src/services/token.service';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { InMemoryEdgeSecurityStore } from '../src/services/edge-security.store';
import { IpRuleService } from '../src/services/ip-rules.service';
import { SECURITY_EVENT_RETENTION_DAYS } from '../src/services/security-events';
import { FakePrisma } from './support/fake-prisma';

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 400 && !condition(); i++) await sleep(5);
  expect(condition()).toBe(true);
};

describe('startSecurityJobs', () => {
  let prisma: FakePrisma;
  let edge: InMemoryEdgeSecurityStore;
  let auth: AuthService;
  let ipRules: IpRuleService;
  let stop: (() => void) | null;

  beforeEach(() => {
    prisma = new FakePrisma();
    edge = new InMemoryEdgeSecurityStore();
    auth = new AuthService({
      prisma: prisma as unknown as PrismaClient,
      tokenService: new TokenService(),
      tokenState: new InMemoryTokenStateStore(),
      security: new InMemoryAuthSecurityStore(),
      mailer: new ConsoleMailer(),
      edge,
      config: { appBaseUrl: 'https://app.example.com', passwordResetTtlMinutes: 30, emailVerificationTtlHours: 24, sessionMaxDays: 30, mfaChallengeTtlSeconds: 300, enrolmentTtlHours: 24, staffEmailDomain: '' },
    });
    ipRules = new IpRuleService(prisma as unknown as PrismaClient, edge, { staffCidrs: [] });
    stop = null;
  });

  afterEach(() => stop?.());

  const seedRetention = () => {
    const [, recentEvent] = prisma.seed('securityEvent', [
      { type: 'SIGN_IN_FAILED', createdAt: new Date(Date.now() - (SECURITY_EVENT_RETENTION_DAYS + 1) * DAY) },
      { type: 'SIGN_IN_SUCCEEDED', createdAt: new Date(Date.now() - (SECURITY_EVENT_RETENTION_DAYS - 1) * DAY) },
    ]);
    const [, liveSession] = prisma.seed('userSession', [
      { userId: 'u1', expiresAt: new Date(Date.now() - 91 * DAY), deviceLabel: 'Chrome on Windows', browser: 'Chrome', os: 'Windows' },
      { userId: 'u1', expiresAt: new Date(Date.now() + DAY), deviceLabel: 'Chrome on Windows', browser: 'Chrome', os: 'Windows' },
    ]);
    return { recentEvent, liveSession };
  };
  const leaseNames = () => prisma.leaseRequests.map((l) => l.name);
  const statements = () => prisma.raw.map((r) => r.sql);

  it('purges security events older than 180 days and sessions that ended over 90 days ago, after taking the job lease', async () => {
    const { recentEvent, liveSession } = seedRetention();
    stop = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules, { ipRulesSyncMs: 60_000, retentionMs: 20 });
    await waitFor(() => prisma.tables.securityEvent.length === 1);

    expect(prisma.tables.securityEvent).toEqual([recentEvent]);
    expect(prisma.tables.userSession).toEqual([liveSession]);
    expect(prisma.leaseRequests).toContainEqual({ name: 'auth-security-retention', ttlSeconds: 1 });
    // The lease comes first, then the deletes, each naming its retention period
    const lease = prisma.raw.findIndex((r) => /job_leases/.test(r.sql) && r.values[0] === 'auth-security-retention');
    const events = statements().findIndex((s) => /DELETE FROM security_events/.test(s));
    const sessions = statements().findIndex((s) => /DELETE FROM user_sessions/.test(s));
    expect(lease).toBeGreaterThanOrEqual(0);
    expect(lease).toBeLessThan(events);
    expect(events).toBeLessThan(sessions);
    expect(prisma.raw[events].values[0]).toBe(SECURITY_EVENT_RETENTION_DAYS);
    expect(prisma.raw[sessions].values[0]).toBe(90);
  });

  it('mirrors the active IP rules to the edge Redis at once and again on every tick; expired and removed rules are left out', async () => {
    const [active, , ,] = prisma.seed('ipRule', [
      { cidr: '203.0.113.0/24', reason: 'abuse', createdBy: 'admin' },
      { cidr: '198.51.100.0/24', reason: 'abuse', createdBy: 'admin', expiresAt: new Date(Date.now() - 1_000) },
      { cidr: '192.0.2.0/24', reason: 'abuse', createdBy: 'admin', removedAt: new Date(), removedBy: 'admin' },
    ]);
    stop = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules, { ipRulesSyncMs: 20, retentionMs: 60_000 });
    await waitFor(() => edge.writes >= 1);
    expect(Object.keys(edge.rules)).toEqual([active.id]);
    expect(JSON.parse(edge.rules[active.id])).toEqual({ cidr: '203.0.113.0/24', expiresAt: null, reason: 'abuse' });
    expect(prisma.leaseRequests[0]).toEqual({ name: 'auth-ip-rules-sync', ttlSeconds: 1 });

    // A rule written by another replica (or restored from a backup) reaches the mirror on the next tick
    const [other] = prisma.seed('ipRule', [{ cidr: '198.51.100.0/24', reason: 'abuse', createdBy: 'admin' }]);
    await waitFor(() => Object.keys(edge.rules).length === 2);
    expect(Object.keys(edge.rules).sort()).toEqual([active.id, other.id].sort());

    // Unchanged rules are not rewritten (no version churn for the gateways to chase)
    const writes = edge.writes;
    await sleep(80);
    expect(edge.writes).toBe(writes);
    expect(leaseNames().filter((n) => n === 'auth-ip-rules-sync').length).toBeGreaterThan(2);
  });

  it('runs nothing on a replica that does not hold the lease', async () => {
    seedRetention();
    prisma.seed('ipRule', [{ cidr: '203.0.113.0/24', reason: 'abuse', createdBy: 'admin' }]);
    prisma.leaseGranted = false;
    stop = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules, { ipRulesSyncMs: 20, retentionMs: 20 });
    await waitFor(() => leaseNames().includes('auth-ip-rules-sync') && leaseNames().includes('auth-security-retention'));
    await sleep(60);
    expect(prisma.tables.securityEvent).toHaveLength(2);
    expect(prisma.tables.userSession).toHaveLength(2);
    expect(edge.writes).toBe(0);
    expect(statements().some((s) => /DELETE FROM/.test(s))).toBe(false);
  });

  it('a failed run is logged and retried on the next tick', async () => {
    seedRetention();
    prisma.executeRawFailures = 1;
    stop = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules, { ipRulesSyncMs: 60_000, retentionMs: 20 });
    await waitFor(() => prisma.tables.securityEvent.length === 1);
    expect(statements().filter((s) => /DELETE FROM security_events/.test(s)).length).toBeGreaterThanOrEqual(2);
  });

  it('stops cleanly: nothing runs after stop()', async () => {
    seedRetention();
    const stopJobs = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules, { ipRulesSyncMs: 20, retentionMs: 20 });
    await waitFor(() => prisma.tables.securityEvent.length === 1 && edge.writes >= 1);
    stopJobs();
    await sleep(30); // a tick already in flight may still finish
    const settled = prisma.raw.length;
    await sleep(80);
    expect(prisma.raw.length).toBe(settled);
    stopJobs(); // idempotent
  });

  it('defaults: rules re-sync every minute and retention runs hourly, each under a lease of 90 % of its interval', async () => {
    stop = startSecurityJobs(prisma as unknown as PrismaClient, auth, ipRules);
    await waitFor(() => prisma.leaseRequests.length >= 1);
    expect(prisma.leaseRequests[0]).toEqual({ name: 'auth-ip-rules-sync', ttlSeconds: 54 });
  });
});
