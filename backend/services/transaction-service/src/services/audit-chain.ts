import crypto from 'crypto';
import { AuditLog, Prisma, PrismaClient } from '../../generated/client';
import { ChainVerification, GENESIS_HASH, auditHash, lockAuditChain, logger, verifyAuditChain } from '@banksphere/common';

type TxClient = Prisma.TransactionClient;

/** The columns of an audit row that its hash covers (everything except the chain columns themselves) */
export interface AuditRowContent {
  id: string;
  seq: bigint;
  actorId: string;
  action: string;
  targetId: string | null;
  details: Prisma.JsonValue | null;
  createdAt: Date;
}

/**
 * The record hashed for a row, built the same way when the row is written and when it is verified, so a
 * value that went through the database (JSONB, TIMESTAMP(3), BIGINT) hashes exactly as it did on write.
 */
export function auditChainRecord(row: AuditRowContent): Record<string, unknown> {
  return {
    id: row.id,
    seq: row.seq,
    actorId: row.actorId,
    action: row.action,
    targetId: row.targetId ?? null,
    details: row.details ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Appends one row to the tamper-evident audit_log, inside the caller's transaction (the only way audit rows
 * are written). It takes the chain's transaction-scoped advisory lock, links the row to the current head
 * (seq + 1, prev_hash = head hash) and stores hash = sha256(prev_hash, canonical JSON of the row).
 *
 * The lock is held until the caller commits, so audit writes are serialised: call this as the LAST locking
 * step of a transaction (after any account, session or authorisation row locks), which keeps one global lock
 * order and no transaction ever waits for a row lock while holding the chain. Use READ COMMITTED (the
 * default): a REPEATABLE READ snapshot taken before the lock could read a stale chain head.
 */
export async function appendAudit(
  tx: TxClient,
  actorId: string,
  action: string,
  targetId: string | null | undefined,
  details?: Record<string, unknown>
): Promise<void> {
  const prevHash = await lockAuditChain(tx, 'audit_log');
  const [head] = await tx.$queryRawUnsafe<Array<{ seq: bigint | number }>>(
    'SELECT seq FROM audit_log WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1'
  );
  const content: AuditRowContent = {
    id: crypto.randomUUID(),
    seq: (head ? BigInt(head.seq) : 0n) + 1n,
    actorId,
    action,
    targetId: targetId ?? null,
    // Exactly what JSON storage keeps (undefined members dropped, Dates as strings), so it hashes the same on read
    details: details === undefined ? null : (JSON.parse(JSON.stringify(details)) as Prisma.JsonValue),
    // Explicit, and millisecond precision like the TIMESTAMP(3) column, so the stored value is the hashed one
    createdAt: new Date(),
  };
  const hash = auditHash(prevHash, auditChainRecord(content));
  await tx.auditLog.create({
    data: {
      ...content,
      details: content.details === null ? undefined : (content.details as Prisma.InputJsonValue),
      prevHash,
      hash,
    },
  });
}

/** Re-walks the chain in pages (keyset on seq), so verification never loads the whole table */
export class AuditChainService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly pageSize = 1000
  ) {}

  public async verify(): Promise<ChainVerification> {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    let after: bigint | null = null;
    for (;;) {
      const rows: AuditLog[] = await this.prisma.auditLog.findMany({
        where: { hash: { not: null }, ...(after !== null && { seq: { gt: after } }) },
        orderBy: { seq: 'asc' },
        take: this.pageSize,
      });
      const page = verifyAuditChain(
        rows.map((row) => ({
          id: row.id,
          prevHash: row.prevHash ?? '',
          hash: row.hash ?? '',
          record: auditChainRecord({ ...row, seq: row.seq ?? 0n }),
        })),
        prevHash
      );
      if (!page.ok) {
        const result: ChainVerification = { ok: false, checked: checked + page.checked, brokenAt: page.brokenAt, reason: page.reason };
        logger.error({ ...result, alert: 'AUDIT_CHAIN_BROKEN' }, 'Ledger audit chain does not verify');
        return result;
      }
      checked += page.checked;
      if (rows.length < this.pageSize) return { ok: true, checked };
      const last: AuditLog = rows[rows.length - 1];
      prevHash = last.hash ?? '';
      after = last.seq ?? 0n;
    }
  }
}
