import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { ConsoleMailer, GENESIS_HASH, InMemoryTokenStateStore, UserRole, auditHash, generateJwtKeyPair, signAccessToken } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

import { PrismaClient } from '../generated/client';
import { createApp } from '../src/app';
import { appendAudit, auditRecord, verifyAuditLog, writeAudit } from '../src/services/audit';
import { InMemoryAuthSecurityStore } from '../src/services/auth-security.store';
import { FakePrisma } from './support/fake-prisma';

const client = (prisma: FakePrisma) => prisma as unknown as PrismaClient;
// The fake's rows are untyped; the hash covers the same fields as a real audit_log row
const recordOf = (row: Record<string, unknown>) => auditRecord(row as Parameters<typeof auditRecord>[0]);
const entry = (n: number) => ({ actorId: 'admin-1', action: `TEST_ACTION_${n}`, targetId: `target-${n}`, details: { n, at: new Date(2026, 9, 31, 10, n), note: undefined } });

describe('audit hash chain (design section 12)', () => {
  let prisma: FakePrisma;
  beforeEach(() => {
    prisma = new FakePrisma();
  });

  it('links every row to the previous one, starting from the genesis hash, over exactly what was stored', async () => {
    for (let n = 1; n <= 5; n++) await writeAudit(client(prisma), entry(n));
    const rows = prisma.tables.auditLog;
    expect(rows).toHaveLength(5);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    for (const row of rows) expect(row.hash).toBe(auditHash(row.prevHash, recordOf(row)));
    // Details are hashed as the database stores them: dates as strings, undefined values dropped
    expect(rows[0].details).toEqual({ n: 1, at: new Date(2026, 9, 31, 10, 1).toISOString() });
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: true, checked: 5 });
  });

  it('reports the first edited row', async () => {
    for (let n = 1; n <= 5; n++) await writeAudit(client(prisma), entry(n));
    const rows = prisma.tables.auditLog;
    rows[2].details = { n: 3, at: rows[2].details.at, note: 'edited by a DBA' };
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: false, checked: 2, brokenAt: rows[2].id, reason: 'content' });
    rows[2].details = { n: 3, at: rows[2].details.at };
    rows[4].actorId = 'someone-else';
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: false, checked: 4, brokenAt: rows[4].id, reason: 'content' });
  });

  it('reports a deleted or inserted row as a broken link at the row that follows it', async () => {
    for (let n = 1; n <= 4; n++) await writeAudit(client(prisma), entry(n));
    const [, second, third] = prisma.tables.auditLog;
    prisma.tables.auditLog = prisma.tables.auditLog.filter((r) => r.id !== second.id);
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: false, checked: 1, brokenAt: third.id, reason: 'link' });

    // A row forged with a valid hash of its own, slipped in between, still breaks the next link
    prisma = new FakePrisma();
    for (let n = 1; n <= 3; n++) await writeAudit(client(prisma), entry(n));
    const [first, , last] = prisma.tables.auditLog;
    const forged = prisma.withDefaults('auditLog', { actorId: 'intruder', action: 'FORGED', targetId: null, details: null, prevHash: first.hash, seq: first.seq + 1n });
    forged.hash = auditHash(forged.prevHash, recordOf(forged));
    prisma.tables.auditLog.splice(1, 0, forged);
    prisma.tables.auditLog.slice(2).forEach((r) => (r.seq = r.seq + 1n));
    expect(await verifyAuditLog(client(prisma))).toMatchObject({ ok: false, checked: 2, reason: 'link' });
    expect((await verifyAuditLog(client(prisma))).brokenAt).not.toBe(last.id === forged.id);
  });

  it('reports reordered rows', async () => {
    for (let n = 1; n <= 3; n++) await writeAudit(client(prisma), entry(n));
    const [, second, third] = prisma.tables.auditLog;
    [second.seq, third.seq] = [third.seq, second.seq];
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: false, checked: 1, brokenAt: third.id, reason: 'link' });
  });

  it('leaves rows written before the chain existed outside it, and links the first chained row to the genesis hash', async () => {
    prisma.seed('auditLog', [{ actorId: 'legacy', action: 'OLD_ACTION', targetId: null, details: null, prevHash: null, hash: null }]);
    await writeAudit(client(prisma), entry(1));
    await writeAudit(client(prisma), entry(2));
    expect(prisma.tables.auditLog[1].prevHash).toBe(GENESIS_HASH);
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: true, checked: 2 });
  });

  it('appends inside the caller’s transaction, so a rolled-back change leaves no audit row and no gap', async () => {
    await writeAudit(client(prisma), entry(1));
    await expect(
      prisma.$transaction(async (tx: PrismaClient) => {
        await appendAudit(tx as never, entry(2));
        throw new Error('the audited change failed');
      })
    ).rejects.toThrow('the audited change failed');
    expect(prisma.tables.auditLog).toHaveLength(1);
    await writeAudit(client(prisma), entry(3));
    expect(prisma.tables.auditLog[1].prevHash).toBe(prisma.tables.auditLog[0].hash);
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: true, checked: 2 });
  });

  it('walks a long chain in batches and still finds a break past the first batch', async () => {
    for (let n = 1; n <= 1_005; n++) await writeAudit(client(prisma), entry(n));
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: true, checked: 1_005 });
    const victim = prisma.tables.auditLog[1_002];
    victim.targetId = 'elsewhere';
    expect(await verifyAuditLog(client(prisma))).toEqual({ ok: false, checked: 1_002, brokenAt: victim.id, reason: 'content' });
  });
});

describe('GET /api/v1/auth/admin/audit/verify', () => {
  let prisma: FakePrisma;
  let app: express.Express;
  const token = (role: UserRole, mfa = true) =>
    signAccessToken({ sub: `${role.toLowerCase()}-1`, email: `${role.toLowerCase()}@bank.com`, role, tokenVersion: 0, mfa, sessionId: crypto.randomUUID() });
  const verify = (role: UserRole = 'BANK_ADMIN') => request(app).get('/api/v1/auth/admin/audit/verify').set('Authorization', `Bearer ${token(role)}`);

  beforeEach(async () => {
    prisma = new FakePrisma();
    app = createApp(client(prisma), { tokenState: new InMemoryTokenStateStore(), security: new InMemoryAuthSecurityStore(), mailer: new ConsoleMailer() }).app;
    for (let n = 1; n <= 3; n++) await writeAudit(client(prisma), entry(n));
  });

  it('is for audit:verify (BANK_ADMIN) only', async () => {
    for (const role of ['SUPPORT', 'FRAUD_ANALYST', 'TELLER', 'KYC_OFFICER', 'CUSTOMER'] as UserRole[]) expect([role, (await verify(role)).status]).toEqual([role, 403]);
    expect((await request(app).get('/api/v1/auth/admin/audit/verify')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/admin/audit/verify').set('Authorization', `Bearer ${token('BANK_ADMIN', false)}`)).body.error.code).toBe('MFA_REQUIRED');
    expect(prisma.tables.auditLog).toHaveLength(3); // refused calls are not audited
  });

  it('re-walks the chain and reports it sound; the check itself becomes the newest link', async () => {
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true, checked: 3 } });
    expect(prisma.tables.auditLog.at(-1)).toEqual(expect.objectContaining({ actorId: 'bank_admin-1', action: 'AUDIT_CHAIN_VERIFIED', targetId: null, details: { ok: true, checked: 3, brokenAt: null } }));
    expect((await verify()).body.data).toEqual({ ok: true, checked: 4 });
  });

  it('reports the first broken link, and audits that outcome', async () => {
    const tampered = prisma.tables.auditLog[1];
    tampered.details = { ...tampered.details, n: 42 };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: false, checked: 1, brokenAt: tampered.id, reason: 'content' });
    expect(prisma.tables.auditLog.at(-1)!.details).toEqual({ ok: false, checked: 1, brokenAt: tampered.id });
  });
});
