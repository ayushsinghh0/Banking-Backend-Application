import crypto from 'crypto';

/**
 * Tamper-evident audit trail. Each audit row stores the hash of the previous row and its own hash over
 * (previous hash, canonical JSON of its content), so changing, deleting or reordering any row breaks every
 * link after it. The database already refuses UPDATE/DELETE on audit tables for the application role; the
 * chain also catches changes made with higher privileges (a DBA, a restored backup, a compromised owner role).
 *
 * Rows are appended under a transaction-scoped advisory lock (see `lockAuditChain`), which keeps the chain
 * linear across replicas. Audit volume is staff actions and security events, far below where that lock matters.
 */
export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: sorted object keys, BigInt as decimal strings, Dates as ISO-8601, undefined dropped */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

export function auditHash(prevHash: string, record: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(prevHash).update('\n').update(canonicalJson(record)).digest('hex');
}

export interface ChainedRow {
  id: string;
  prevHash: string;
  hash: string;
  /** Exactly the fields that were hashed when the row was written */
  record: Record<string, unknown>;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** Id of the first row whose link or content doesn't verify */
  brokenAt?: string;
  reason?: 'content' | 'link';
}

/** Verifies rows in chain order (ascending seq), starting from `startPrevHash` (the genesis by default) */
export function verifyAuditChain(rows: Iterable<ChainedRow>, startPrevHash = GENESIS_HASH): ChainVerification {
  let expectedPrev = startPrevHash;
  let checked = 0;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) return { ok: false, checked, brokenAt: row.id, reason: 'link' };
    if (auditHash(row.prevHash, row.record) !== row.hash) return { ok: false, checked, brokenAt: row.id, reason: 'content' };
    expectedPrev = row.hash;
    checked += 1;
  }
  return { ok: true, checked };
}

/** Minimal Prisma surface for the chain helpers (works with a transaction client) */
export interface AuditChainClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const TABLE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Takes the chain lock for `table` (until the surrounding transaction ends) and returns the hash to link the
 * next row to. Call inside the transaction that inserts the row.
 */
export async function lockAuditChain(tx: AuditChainClient, table = 'audit_log'): Promise<string> {
  if (!TABLE.test(table)) throw new Error(`Invalid audit table name '${table}'`);
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text`, `audit-chain:${table}`);
  const rows = await tx.$queryRawUnsafe<Array<{ hash: string }>>(
    `SELECT hash FROM ${table} WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1`
  );
  return rows[0]?.hash ?? GENESIS_HASH;
}
