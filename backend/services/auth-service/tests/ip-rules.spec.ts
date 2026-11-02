import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import Redis from 'ioredis';
import { AuthenticatedUser, ConsoleMailer, InMemoryTokenStateStore, UserRole, generateJwtKeyPair, signAccessToken } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { createApp } from '../src/app';
import { IpRuleService, MAX_ACTIVE_RULES } from '../src/services/ip-rules.service';
import { IP_RULES_KEY, IP_RULES_VERSION_KEY, InMemoryEdgeSecurityStore, RedisEdgeSecurityStore } from '../src/services/edge-security.store';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { parseCidrList } from '../src/services/ip-address';
import { FakePrisma } from './support/fake-prisma';
import { FakeRedis } from './support/fake-redis';

const ADMIN = 'a0b1c2d3-e4f5-4678-9abc-def012345678';
const admin: AuthenticatedUser = { id: ADMIN, email: 'admin@bank.com', role: 'BANK_ADMIN' };
const REASON = 'Scanning our sign-in page';

describe('IpRuleService', () => {
  let clock: number;
  let prisma: FakePrisma;
  let redis: FakeRedis;
  let edge: RedisEdgeSecurityStore;
  let service: IpRuleService;

  beforeEach(() => {
    clock = Date.parse('2026-10-31T10:00:00.000Z');
    const now = () => clock;
    prisma = new FakePrisma();
    redis = new FakeRedis(now);
    edge = new RedisEdgeSecurityStore(redis as unknown as Redis, now);
    service = new IpRuleService(prisma as unknown as PrismaClient, edge, { staffCidrs: parseCidrList('10.20.0.0/16, fd00:20::/32'), now });
  });

  const mirror = () => redis.hgetall(IP_RULES_KEY);
  const version = () => redis.get(IP_RULES_VERSION_KEY);
  const audits = () => prisma.tables.auditLog.map((a) => [a.actorId, a.action, a.targetId]);

  it('stores the canonical network, mirrors it to the edge hash with a new version, and audits the change', async () => {
    const rule = await service.create(admin, { cidr: '203.0.113.77/24', reason: `  ${REASON}\t`, expiresInMinutes: 60 }, '198.51.100.9');
    expect(rule).toEqual({
      id: expect.any(String),
      cidr: '203.0.113.0/24',
      action: 'DENY',
      reason: REASON,
      expiresAt: new Date(clock + 3_600_000),
      createdBy: ADMIN,
      createdAt: expect.any(Date),
    });
    expect(await mirror()).toEqual({ [rule.id]: JSON.stringify({ cidr: '203.0.113.0/24', expiresAt: new Date(clock + 3_600_000).toISOString(), reason: REASON }) });
    const v1 = await version();
    expect(v1).toEqual(expect.any(String));
    expect(await service.list()).toEqual([rule]);
    expect(prisma.tables.auditLog).toEqual([
      expect.objectContaining({ actorId: ADMIN, action: 'IP_RULE_CREATED', targetId: rule.id, details: { cidr: '203.0.113.0/24', reason: REASON, expiresAt: rule.expiresAt!.toISOString() }, hash: expect.any(String) }),
    ]);

    // A second rule (IPv6, open-ended) joins the hash; the version moves so every gateway replica reloads
    const v6 = await service.create(admin, { cidr: '2001:db8:bad::/48', reason: REASON }, '198.51.100.9');
    expect(v6.cidr).toBe('2001:db8:bad::/48');
    expect(v6.expiresAt).toBeNull();
    expect(Object.keys(await mirror()).sort()).toEqual([rule.id, v6.id].sort());
    expect(JSON.parse((await mirror())[v6.id])).toEqual({ cidr: '2001:db8:bad::/48', expiresAt: null, reason: REASON });
    expect(await version()).not.toBe(v1);
    expect((await service.list()).map((r) => r.id)).toEqual([v6.id, rule.id]); // newest first
  });

  it('refuses a duplicate of an active rule and caps the active rules', async () => {
    await service.create(admin, { cidr: '203.0.113.0/24', reason: REASON }, undefined);
    await expect(service.create(admin, { cidr: '203.0.113.9', reason: REASON }, undefined)).resolves.toMatchObject({ cidr: '203.0.113.9/32' });
    await expect(service.create(admin, { cidr: '203.0.113.200/24', reason: REASON }, undefined)).rejects.toMatchObject({ statusCode: 409 });
    prisma.seed('ipRule', Array.from({ length: MAX_ACTIVE_RULES }, (_, i) => ({ cidr: `10.${100 + Math.floor(i / 256)}.${i % 256}.0/24`, reason: REASON, createdBy: ADMIN })));
    await expect(service.create(admin, { cidr: '192.0.2.0/24', reason: REASON }, undefined)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('removing a rule drops it from the mirror, bumps the version and is audited; a removed or unknown rule is 404', async () => {
    const keep = await service.create(admin, { cidr: '203.0.113.0/24', reason: REASON }, undefined);
    const gone = await service.create(admin, { cidr: '198.51.100.0/24', reason: REASON }, undefined);
    const before = await version();

    await service.remove(admin, gone.id);
    expect(Object.keys(await mirror())).toEqual([keep.id]);
    expect(await version()).not.toBe(before);
    expect((await service.list()).map((r) => r.id)).toEqual([keep.id]);
    // The row stays as history
    expect(prisma.tables.ipRule.find((r) => r.id === gone.id)).toEqual(expect.objectContaining({ removedAt: new Date(clock), removedBy: ADMIN }));
    expect(audits()).toEqual([[ADMIN, 'IP_RULE_CREATED', keep.id], [ADMIN, 'IP_RULE_CREATED', gone.id], [ADMIN, 'IP_RULE_REMOVED', gone.id]]);

    await expect(service.remove(admin, gone.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.remove(admin, crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    expect(audits()).toHaveLength(3);
  });

  describe('refusals', () => {
    const refuse = (input: { cidr: string; reason?: string; expiresInMinutes?: number }, callerIp: string | undefined, code: string) =>
      expect(service.create(admin, { reason: REASON, ...input }, callerIp)).rejects.toMatchObject({ statusCode: 400, errorCode: code });

    it('malformed networks', async () => {
      for (const cidr of ['not-an-ip', '203.0.113.0/33', '203.0.113/24', '2001:db8::/129', '203.0.113.0/24/8', '']) await refuse({ cidr }, undefined, 'INVALID_CIDR');
      // IPv4 written as an IPv4-mapped IPv6 network would dodge the IPv4 width rule
      await refuse({ cidr: '::ffff:203.0.113.0/120' }, undefined, 'INVALID_CIDR');
    });

    it('rules wider than /8 (IPv4) or /32 (IPv6)', async () => {
      for (const cidr of ['10.0.0.0/7', '0.0.0.0/0', '203.0.0.0/6']) await refuse({ cidr }, undefined, 'RULE_TOO_WIDE');
      for (const cidr of ['2001:db8::/31', '2000::/3', '::/0']) await refuse({ cidr }, undefined, 'RULE_TOO_WIDE');
      // Exactly at the limit is allowed
      expect(service.validate({ cidr: '11.0.0.0/8', reason: REASON }, undefined).cidr.text).toBe('11.0.0.0/8');
      expect(service.validate({ cidr: '2001:db8::/32', reason: REASON }, undefined).cidr.text).toBe('2001:db8::/32');
    });

    it('rules overlapping STAFF_ALLOWED_CIDRS, in either direction', async () => {
      for (const cidr of ['10.20.5.0/24', '10.20.0.0/16', '10.0.0.0/8', '10.20.1.7', 'fd00:20:1::/48', 'fd00:20::/32']) await refuse({ cidr }, undefined, 'RULE_OVERLAPS_STAFF_NETWORK');
      // Neighbouring networks are fine
      expect(service.validate({ cidr: '10.21.0.0/16', reason: REASON }, undefined).cidr.text).toBe('10.21.0.0/16');
    });

    it("rules containing the administrator's own address, however it is written", async () => {
      await refuse({ cidr: '198.51.100.0/24' }, '198.51.100.9', 'RULE_BLOCKS_YOU');
      await refuse({ cidr: '198.51.100.9' }, '::ffff:198.51.100.9', 'RULE_BLOCKS_YOU');
      await refuse({ cidr: '2001:db8:bad::/48' }, '2001:DB8:BAD:0:0:0:0:1', 'RULE_BLOCKS_YOU');
      // Unknown caller address: no self-lockout check is possible, the rule is judged on its own
      expect(service.validate({ cidr: '198.51.100.0/24', reason: REASON }, undefined).cidr.text).toBe('198.51.100.0/24');
    });

    it('reasons and expiries outside their bounds', async () => {
      await refuse({ cidr: '203.0.113.0/24', reason: 'abc' }, undefined, 'INVALID_REASON');
      await refuse({ cidr: '203.0.113.0/24', reason: 'x'.repeat(201) }, undefined, 'INVALID_REASON');
      await refuse({ cidr: '203.0.113.0/24', reason: '\u0000\u0001   ' }, undefined, 'INVALID_REASON');
      for (const expiresInMinutes of [0, 4, 365 * 24 * 60 + 1, 2.5]) await refuse({ cidr: '203.0.113.0/24', expiresInMinutes }, undefined, 'INVALID_EXPIRY');
      expect(service.validate({ cidr: '203.0.113.0/24', reason: REASON, expiresInMinutes: 5 }, undefined).expiresAt).toEqual(new Date(clock + 5 * 60_000));
    });

    it('write nothing: no row, no audit, no mirror change', async () => {
      await refuse({ cidr: '10.0.0.0/7' }, undefined, 'RULE_TOO_WIDE');
      await refuse({ cidr: '10.20.5.0/24' }, undefined, 'RULE_OVERLAPS_STAFF_NETWORK');
      expect(prisma.tables.ipRule).toEqual([]);
      expect(prisma.tables.auditLog).toEqual([]);
      expect(redis.keys()).toEqual([]);
    });
  });

  it('a rule stops applying when it expires: it leaves the list and, on the next sync, the mirror', async () => {
    const short = await service.create(admin, { cidr: '203.0.113.0/24', reason: REASON, expiresInMinutes: 5 }, undefined);
    const forever = await service.create(admin, { cidr: '198.51.100.0/24', reason: REASON }, undefined);
    const before = await version();
    expect(await service.syncMirror()).toBe(false); // nothing changed since the last write: no version churn
    expect(await version()).toBe(before);

    clock += 5 * 60_000 + 1;
    expect((await service.list()).map((r) => r.id)).toEqual([forever.id]);
    expect(await service.syncMirror()).toBe(true);
    expect(Object.keys(await mirror())).toEqual([forever.id]);
    expect(await version()).not.toBe(before);
    expect(prisma.tables.ipRule.find((r) => r.id === short.id)).toBeDefined(); // history is kept
  });

  it('re-mirrors from the database when the edge Redis lost the keys (eviction)', async () => {
    const rule = await service.create(admin, { cidr: '203.0.113.0/24', reason: REASON }, undefined);
    await redis.del(IP_RULES_KEY, IP_RULES_VERSION_KEY);
    expect(await service.syncMirror()).toBe(true);
    expect(Object.keys(await mirror())).toEqual([rule.id]);
    expect(await version()).toEqual(expect.any(String));
  });

  describe('automatic bans', () => {
    it('lists the active edge bans with masked addresses and their remaining time; lifting one is audited', async () => {
      const bannedAt = new Date(clock).toISOString();
      expect(await edge.banIp('203.0.113.9', 1800, { reason: 'CREDENTIAL_STUFFING', bannedAt, source: 'auth-service', distinctAccounts: 21 })).toBe(true);
      expect(await edge.banIp('2001:db8:1:2::/64', 600, { reason: 'CREDENTIAL_STUFFING', bannedAt, source: 'auth-service' })).toBe(true);
      // Already banned: the existing ban (and its TTL) stands
      expect(await edge.banIp('203.0.113.9', 60, { reason: 'CREDENTIAL_STUFFING', bannedAt, source: 'auth-service' })).toBe(false);
      expect(redis.keys().sort()).toEqual(['edge:ban:2001:db8:1:2::/64', 'edge:ban:203.0.113.9']);
      expect(await redis.pttl('edge:ban:203.0.113.9')).toBe(1_800_000);

      const { bans, complete } = await service.listBans();
      expect(complete).toBe(true);
      expect(bans.sort((a, b) => a.ipKey.localeCompare(b.ipKey))).toEqual([
        { ipKey: '2001:db8:1:2::/64', ipMasked: '2001:db8:1::/48', reason: 'CREDENTIAL_STUFFING', bannedAt, expiresAt: new Date(clock + 600_000).toISOString() },
        { ipKey: '203.0.113.9', ipMasked: '203.0.113.x', reason: 'CREDENTIAL_STUFFING', bannedAt, expiresAt: new Date(clock + 1_800_000).toISOString() },
      ]);

      await service.liftBan(admin, '203.0.113.9');
      expect(await redis.get('edge:ban:203.0.113.9')).toBeNull();
      expect(audits()).toEqual([[ADMIN, 'IP_BAN_LIFTED', '203.0.113.9']]);
      await expect(service.liftBan(admin, '203.0.113.9')).rejects.toMatchObject({ statusCode: 404 });
      // Only well-formed ban keys ever reach Redis (the key is interpolated into a key name)
      for (const bad of ['edge:ban:x', '203.0.113.9/32', '2001:db8:1:2::5', '*', '']) {
        await expect(service.liftBan(admin, bad)).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_IP_KEY' });
      }

      // A ban ends with its TTL
      clock += 600_001;
      expect((await service.listBans()).bans).toEqual([]);
    });
  });
});

describe('IP rules over HTTP (behind the gateway, staff on 10.20.0.0/16)', () => {
  let app: express.Express;
  let prisma: FakePrisma;
  let edge: InMemoryEdgeSecurityStore;
  const staff = (role: UserRole, mfa = true) =>
    signAccessToken({ sub: `${role.toLowerCase()}-1`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa, sessionId: crypto.randomUUID() });
  const as = (role: UserRole, ip = '10.20.1.5', mfa = true) => ({ Authorization: `Bearer ${staff(role, mfa)}`, 'X-Forwarded-For': ip });
  const NEW_RULE = { cidr: '203.0.113.0/24', reason: REASON, expiresInMinutes: 30 };

  beforeAll(() => {
    process.env.STAFF_ALLOWED_CIDRS = '10.20.0.0/16';
    process.env.TRUST_PROXY = '1';
  });
  afterAll(() => {
    delete process.env.STAFF_ALLOWED_CIDRS;
    delete process.env.TRUST_PROXY;
  });
  beforeEach(() => {
    prisma = new FakePrisma();
    edge = new InMemoryEdgeSecurityStore();
    app = createApp(prisma as unknown as PrismaClient, { tokenState: new InMemoryTokenStateStore(), security: new InMemoryAuthSecurityStore(), mailer: new ConsoleMailer(), edge }).app;
  });

  it('BANK_ADMIN creates, SUPPORT and BANK_ADMIN read, BANK_ADMIN removes; the edge mirror follows every change', async () => {
    const created = await request(app).post('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN')).send(NEW_RULE);
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual(expect.objectContaining({ cidr: '203.0.113.0/24', action: 'DENY', reason: REASON, createdBy: 'bank_admin-1', expiresAt: expect.any(String) }));
    const id = created.body.data.id as string;
    expect(JSON.parse(edge.rules[id])).toEqual({ cidr: '203.0.113.0/24', expiresAt: created.body.data.expiresAt, reason: REASON });
    const v1 = edge.version;
    expect(v1).toEqual(expect.any(String));

    expect((await request(app).post('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN')).send(NEW_RULE)).status).toBe(409);
    expect((await request(app).get('/api/v1/auth/admin/ip-rules').set(as('SUPPORT'))).body.data).toEqual([expect.objectContaining({ id })]);
    expect((await request(app).get('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN'))).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/admin/ip-rules').set(as('TELLER'))).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/admin/ip-rules').set(as('SUPPORT')).send({ ...NEW_RULE, cidr: '198.51.100.0/24' })).status).toBe(403);

    const removed = await request(app).delete(`/api/v1/auth/admin/ip-rules/${id}`).set(as('BANK_ADMIN'));
    expect(removed.body).toEqual({ success: true, data: { id, removed: true } });
    expect(edge.rules).toEqual({});
    expect(edge.version).not.toBe(v1);
    expect((await request(app).delete(`/api/v1/auth/admin/ip-rules/${id}`).set(as('BANK_ADMIN'))).status).toBe(404);
    expect((await request(app).delete('/api/v1/auth/admin/ip-rules/not-a-uuid').set(as('BANK_ADMIN'))).status).toBe(400);
    expect(prisma.tables.auditLog.map((a) => a.action)).toEqual(['IP_RULE_CREATED', 'IP_RULE_REMOVED']);
  });

  it('refusals surface with their codes; the request shape is strict', async () => {
    const post = (body: object, ip = '10.20.1.5') => request(app).post('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN', ip)).send(body);
    expect((await post({ ...NEW_RULE, cidr: '10.20.0.0/24' })).body.error.code).toBe('RULE_OVERLAPS_STAFF_NETWORK');
    expect((await post({ ...NEW_RULE, cidr: '10.0.0.0/7' })).body.error.code).toBe('RULE_TOO_WIDE');
    expect((await post({ ...NEW_RULE, cidr: 'everyone' })).body.error.code).toBe('INVALID_CIDR');
    expect((await post({ ...NEW_RULE, reason: 'no' })).body.error.code).toBe('INVALID_REASON');
    expect((await post({ ...NEW_RULE, expiresInMinutes: 1 })).body.error.code).toBe('INVALID_EXPIRY');
    expect((await post({ ...NEW_RULE, expiresInMinutes: 1.5 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ ...NEW_RULE, action: 'ALLOW' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ cidr: '203.0.113.0/24' })).body.error.code).toBe('VALIDATION_ERROR');
    expect(edge.writes).toBe(0);
    expect(prisma.tables.ipRule).toEqual([]);
  });

  it('staff must be on the staff network and have an MFA session', async () => {
    expect((await request(app).get('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN', '203.0.113.5'))).body.error.code).toBe('NETWORK_NOT_ALLOWED');
    expect((await request(app).get('/api/v1/auth/admin/ip-rules').set(as('BANK_ADMIN', '10.20.1.5', false))).body.error.code).toBe('MFA_REQUIRED');
    expect((await request(app).get('/api/v1/auth/admin/ip-rules')).status).toBe(401);
  });

  it('lists and lifts automatic bans, IPv6 /64 keys included', async () => {
    const bannedAt = new Date().toISOString();
    await edge.banIp('203.0.113.9', 1800, { reason: 'CREDENTIAL_STUFFING', bannedAt, source: 'auth-service', distinctAccounts: 23 });
    await edge.banIp('2001:db8:1:2::/64', 1800, { reason: 'CREDENTIAL_STUFFING', bannedAt, source: 'auth-service' });

    const list = await request(app).get('/api/v1/auth/admin/ip-bans').set(as('SUPPORT'));
    expect(list.status).toBe(200);
    expect(list.body.pagination).toEqual({ complete: true });
    expect(list.body.data.sort((a: { ipKey: string }, b: { ipKey: string }) => a.ipKey.localeCompare(b.ipKey))).toEqual([
      { ipKey: '2001:db8:1:2::/64', ipMasked: '2001:db8:1::/48', reason: 'CREDENTIAL_STUFFING', bannedAt, expiresAt: expect.any(String) },
      { ipKey: '203.0.113.9', ipMasked: '203.0.113.x', reason: 'CREDENTIAL_STUFFING', bannedAt, expiresAt: expect.any(String) },
    ]);

    expect((await request(app).delete('/api/v1/auth/admin/ip-bans/203.0.113.9').set(as('SUPPORT'))).status).toBe(403);
    expect((await request(app).delete('/api/v1/auth/admin/ip-bans/203.0.113.9').set(as('BANK_ADMIN'))).body).toEqual({ success: true, data: { ipKey: '203.0.113.9', lifted: true } });
    // The slash of an IPv6 key travels percent-encoded in the path
    expect((await request(app).delete('/api/v1/auth/admin/ip-bans/2001:db8:1:2::%2F64').set(as('BANK_ADMIN'))).body.data).toEqual({ ipKey: '2001:db8:1:2::/64', lifted: true });
    expect(edge.bans.size).toBe(0);
    expect((await request(app).delete('/api/v1/auth/admin/ip-bans/203.0.113.9').set(as('BANK_ADMIN'))).status).toBe(404);
    expect((await request(app).delete('/api/v1/auth/admin/ip-bans/not-a-key').set(as('BANK_ADMIN'))).body.error.code).toBe('INVALID_IP_KEY');
    expect(prisma.tables.auditLog.map((a) => [a.action, a.targetId])).toEqual([['IP_BAN_LIFTED', '203.0.113.9'], ['IP_BAN_LIFTED', '2001:db8:1:2::/64']]);
  });
});
