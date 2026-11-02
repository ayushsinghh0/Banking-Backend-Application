import crypto from 'crypto';
import { auditHash, ChainVerification, GENESIS_HASH, lockAuditChain, verifyAuditChain } from '@banksphere/common';
import { Prisma, PrismaClient } from '../../generated/client';

/**
 * The single way auth-service writes audit_log (design section 12). Each row is linked into a hash chain:
 * under a transaction-scoped advisory lock the writer reads the newest chained row's hash, then inserts its row
 * with prev_hash = that hash and hash = sha256(prev_hash, canonical JSON of the row). The lock keeps the chain
 * linear across replicas, and because it is held until the surrounding transaction ends, a rolled-back write
 * leaves no gap in the links. Rows written before the chain existed (seq NULL) are outside it.
 */
export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetId: string | null;
  details?: Record<string, unknown>;
}

type Tx = Prisma.TransactionClient;

/** The exact fields covered by a row's hash; verification rebuilds the same object from the stored row */
export function auditRecord(row: {
  id: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  details: unknown;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetId: row.targetId,
    details: row.details ?? null,
    createdAt: row.createdAt,
  };
}

/** Appends one chained audit row; call inside the transaction that makes the audited change */
export async function appendAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const prevHash = await lockAuditChain(tx);
  // Serialise exactly what will be stored: JSON drops undefined values and turns Dates into strings
  const details = entry.details === undefined ? undefined : (JSON.parse(JSON.stringify(entry.details)) as Record<string, unknown>);
  const row = {
    id: crypto.randomUUID(),
    actorId: entry.actorId,
    action: entry.action,
    targetId: entry.targetId,
    details,
    // Set here, not by the database default, so the hash covers the stored timestamp exactly (millisecond precision)
    createdAt: new Date(),
  };
  await tx.auditLog.create({
    data: {
      ...row,
      details: details as Prisma.InputJsonValue | undefined,
      prevHash,
      hash: auditHash(prevHash, auditRecord(row)),
    },
  });
}

/** Writes through `client`: inside its transaction, or in a transaction of its own for the root client */
export async function writeAudit(client: Tx | PrismaClient, entry: AuditEntry): Promise<void> {
  if ('$transaction' in client && typeof client.$transaction === 'function') {
    await (client as PrismaClient).$transaction((tx) => appendAudit(tx, entry));
    return;
  }
  await appendAudit(client as Tx, entry);
}

const VERIFY_BATCH = 1_000;

/**
 * Re-walks the whole chain in seq order, batch by batch, and reports the first row whose link or content
 * doesn't verify. Detects edited, deleted, inserted and reordered rows; cutting rows off the END of the chain
 * can only be detected against an external copy of the latest hash.
 */
export async function verifyAuditLog(prisma: Pick<PrismaClient, 'auditLog'>): Promise<ChainVerification> {
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let after: bigint | null = null;
  for (;;) {
    const rows: Array<{ id: string; seq: bigint | null; actorId: string | null; action: string; targetId: string | null; details: unknown; createdAt: Date; prevHash: string | null; hash: string | null }> =
      await prisma.auditLog.findMany({
        where: { hash: { not: null }, ...(after !== null ? { seq: { gt: after } } : {}) },
        orderBy: { seq: 'asc' },
        take: VERIFY_BATCH,
      });
    const result = verifyAuditChain(
      rows.map((row) => ({ id: row.id, prevHash: row.prevHash ?? '', hash: row.hash ?? '', record: auditRecord(row) })),
      prevHash
    );
    checked += result.checked;
    if (!result.ok) return { ...result, checked };
    if (rows.length < VERIFY_BATCH) return { ok: true, checked };
    const last = rows[rows.length - 1];
    prevHash = last.hash!;
    after = last.seq;
  }
}
