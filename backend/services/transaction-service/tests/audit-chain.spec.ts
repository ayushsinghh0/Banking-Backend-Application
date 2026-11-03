import express from 'express';
import request from 'supertest';
import { AuthenticatedUser, GENESIS_HASH, auditHash, errorHandlerMiddleware } from '@banksphere/common';
import { AuditChainService, appendAudit, auditChainRecord } from '../src/services/audit-chain';
import { createTransactionRouter } from '../src/routes/transaction.routes';
import { TransactionController } from '../src/controllers/transaction.controller';

/** JSONB keeps no key order: return objects with their keys reversed, as a stored row might come back */
function reorderKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reorderKeys(value[k])]));
  return value;
}

/** audit_log as the database keeps it: the chain columns, JSONB details, append-only */
function auditTable() {
  const rows: any[] = [];
  const sql: string[] = [];
  const client: any = {
    $queryRawUnsafe: jest.fn(async (query: string, ...values: unknown[]) => {
      sql.push(query.replace(/\s+/g, ' ').trim() + (values.length ? ` [${values.join(',')}]` : ''));
      const chained = rows.filter((r) => r.hash !== null).sort((a, b) => (a.seq < b.seq ? -1 : 1));
      if (query.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }];
      if (query.startsWith('SELECT hash')) return chained.length ? [{ hash: chained.at(-1).hash }] : [];
      if (query.startsWith('SELECT seq')) return chained.length ? [{ seq: chained.at(-1).seq }] : [];
      throw new Error(`unexpected SQL ${query}`);
    }),
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        rows.push({ targetId: null, ...data, details: data.details === undefined ? null : reorderKeys(JSON.parse(JSON.stringify(data.details))) });
        return data;
      }),
      findMany: jest.fn(async ({ where, take }: any) =>
        rows
          .filter((r) => r.hash !== null && (where.seq?.gt === undefined || r.seq > where.seq.gt))
          .sort((a, b) => (a.seq < b.seq ? -1 : 1))
          .slice(0, take)
          .map((r) => ({ ...r }))
      ),
    },
  };
  return { client, rows, sql };
}

async function writeChain(n: number) {
  const table = auditTable();
  for (let i = 1; i <= n; i++) {
    await appendAudit(table.client, `actor-${i}`, i % 2 ? 'STAFF_VIEW_BALANCE' : 'CASH_DEPOSIT_EXECUTED', `target-${i}`, {
      amountInPaise: String(i * 100),
      nested: { b: i, a: [1, 2, { z: 'x', y: null }] },
      at: new Date('2026-10-28T10:00:00.123Z'), // stored as its ISO string, hashed the same way
      skipped: undefined,
    });
  }
  return table;
}

describe('Tamper-evident audit_log', () => {
  it('APPEND: each row links to the previous one (seq + 1, prev_hash = previous hash, hash over the row)', async () => {
    const { rows, sql } = await writeChain(3);
    expect(rows.map((r) => r.seq)).toEqual([1n, 2n, 3n]);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
    for (const row of rows) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.createdAt).toBeInstanceOf(Date); // explicit, so the stored timestamp is the hashed one
      expect(row.hash).toBe(auditHash(row.prevHash, auditChainRecord(row)));
    }
    // The chain lock is taken first, under the per-table key, before the head is read and the row inserted
    expect(sql.slice(0, 3)).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text [audit-chain:audit_log]',
      'SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1',
      'SELECT seq FROM audit_log WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1',
    ]);
  });

  it('VERIFY: an intact chain verifies across pages, whatever key order JSONB returns; pre-chain rows are outside it', async () => {
    const table = await writeChain(7);
    table.rows.unshift({ id: 'legacy-1', seq: null, prevHash: null, hash: null, actorId: 'old', action: 'OLD', details: { x: 1 }, createdAt: new Date(0) });
    expect(await new AuditChainService(table.client, 3).verify()).toEqual({ ok: true, checked: 7 });
    expect(table.client.auditLog.findMany).toHaveBeenCalledTimes(3); // 3 + 3 + 1: streamed, never the whole table
    expect(table.client.auditLog.findMany.mock.calls[1][0]).toEqual({ where: { hash: { not: null }, seq: { gt: 3n } }, orderBy: { seq: 'asc' }, take: 3 });
    expect(await new AuditChainService(auditTable().client).verify()).toEqual({ ok: true, checked: 0 });
  });

  it('TAMPERED CONTENT: an edited row is reported as the first broken link', async () => {
    const table = await writeChain(5);
    table.rows[2].details = { ...table.rows[2].details, amountInPaise: '999999' };
    expect(await new AuditChainService(table.client, 2).verify()).toEqual({ ok: false, checked: 2, brokenAt: table.rows[2].id, reason: 'content' });

    const actor = await writeChain(3);
    actor.rows[0].actorId = 'someone-else';
    expect(await new AuditChainService(actor.client).verify()).toEqual({ ok: false, checked: 0, brokenAt: actor.rows[0].id, reason: 'content' });
  });

  it('DELETED, RE-HASHED OR REORDERED rows break the link after them', async () => {
    const deleted = await writeChain(5);
    const [removed] = deleted.rows.splice(2, 1);
    expect(removed).toBeDefined();
    expect(await new AuditChainService(deleted.client).verify()).toEqual({ ok: false, checked: 2, brokenAt: deleted.rows[2].id, reason: 'link' });

    // A privileged editor who also recomputes the edited row's own hash still breaks the next link
    const rehashed = await writeChain(5);
    const row = rehashed.rows[1];
    row.action = 'NOTHING_TO_SEE';
    row.hash = auditHash(row.prevHash, auditChainRecord(row));
    expect(await new AuditChainService(rehashed.client).verify()).toEqual({ ok: false, checked: 2, brokenAt: rehashed.rows[2].id, reason: 'link' });

    const swapped = await writeChain(4);
    [swapped.rows[1].seq, swapped.rows[2].seq] = [swapped.rows[2].seq, swapped.rows[1].seq];
    expect((await new AuditChainService(swapped.client).verify()).ok).toBe(false);

    const headDeleted = await writeChain(3);
    headDeleted.rows.shift();
    expect(await new AuditChainService(headDeleted.client).verify()).toEqual({ ok: false, checked: 0, brokenAt: headDeleted.rows[0].id, reason: 'link' });
  });

  it('GET /audit/verify: BANK_ADMIN (audit:verify) only, answers { ok, checked, brokenAt? }', async () => {
    const table = await writeChain(2);
    table.rows[1].targetId = 'changed';
    const users: Record<string, AuthenticatedUser> = {
      admin: { id: 'admin', email: 'admin@bank.com', role: 'BANK_ADMIN', mfa: true },
      support: { id: 'support', email: 'support@bank.com', role: 'SUPPORT', mfa: true },
      alice: { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER' },
    };
    const app = express();
    app.use(
      '/api/v1/transactions',
      createTransactionRouter(new TransactionController({} as any, {} as any, {} as any, {} as any, new AuditChainService(table.client)), (req, _res, next) => {
        req.user = users[String(req.headers['x-test-user'])];
        next();
      })
    );
    app.use(errorHandlerMiddleware);

    const ok = await request(app).get('/api/v1/transactions/audit/verify').set('x-test-user', 'admin');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, data: { ok: false, checked: 1, brokenAt: table.rows[1].id, reason: 'content' } });
    for (const who of ['support', 'alice']) {
      expect((await request(app).get('/api/v1/transactions/audit/verify').set('x-test-user', who)).status).toBe(403);
    }
  });
});
