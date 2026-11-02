import { Prisma, PrismaClient, SecurityEventType } from '../../generated/client';
import { BadRequestError, logger } from '@banksphere/common';
import { maskIp } from './ip-address';

/**
 * Account security history (design section 9): sign-ins, failures, new devices, revoked sessions, password
 * changes and automatic bans. Shown to the account holder ("recent activity") and to staff. Addresses are
 * stored in full for investigations and only ever returned masked to the network part.
 */
export const SECURITY_EVENT_TYPES = Object.values(SecurityEventType) as SecurityEventType[];
export const SECURITY_EVENT_RETENTION_DAYS = 180;

export interface SecurityEventInput {
  type: SecurityEventType;
  userId: string | null;
  ip?: string | null;
  deviceLabel?: string | null;
  details?: Record<string, unknown>;
}

export interface SecurityEventView {
  id: string;
  type: SecurityEventType;
  userId?: string | null;
  deviceLabel: string | null;
  ipMasked: string | null;
  at: Date;
  details: Record<string, unknown> | null;
}

type Client = Prisma.TransactionClient | PrismaClient;

interface Row {
  id: string;
  type: SecurityEventType;
  userId: string | null;
  ip: string | null;
  deviceLabel: string | null;
  details: unknown;
  createdAt: Date;
}

const view = (row: Row, withUser: boolean): SecurityEventView => ({
  id: row.id,
  type: row.type,
  ...(withUser ? { userId: row.userId } : {}),
  deviceLabel: row.deviceLabel,
  ipMasked: maskIp(row.ip),
  at: row.createdAt,
  details: (row.details as Record<string, unknown> | null) ?? null,
});

/** Opaque keyset cursor: (createdAt, id) of the last row returned */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at);
  if (rest.length || !id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new BadRequestError('Invalid cursor');
  }
  return { createdAt, id };
}

export class SecurityEvents {
  constructor(private readonly prisma: PrismaClient) {}

  public async record(client: Client, event: SecurityEventInput): Promise<void> {
    await client.securityEvent.create({
      data: {
        type: event.type,
        userId: event.userId,
        ip: event.ip ?? null,
        deviceLabel: event.deviceLabel ?? null,
        details: event.details as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** For events outside a transaction: a failure to record must never change the answer the user gets */
  public async recordSafely(event: SecurityEventInput): Promise<void> {
    try {
      await this.record(this.prisma, event);
    } catch (err) {
      logger.error({ err, type: event.type }, 'Could not record a security event');
    }
  }

  /** The account holder's own recent activity, newest first */
  public async listForUser(userId: string, limit: number): Promise<SecurityEventView[]> {
    const rows = await this.prisma.securityEvent.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => view(row, false));
  }

  /** Staff view: filtered by type and user, keyset-paginated newest first */
  public async list(filter: { type?: SecurityEventType; userId?: string; limit: number; cursor?: string }) {
    const where: Prisma.SecurityEventWhereInput = {};
    if (filter.type) where.type = filter.type;
    if (filter.userId) where.userId = filter.userId;
    if (filter.cursor) {
      const { createdAt, id } = decodeCursor(filter.cursor);
      where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }];
    }
    const rows = await this.prisma.securityEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
    const page = rows.slice(0, filter.limit);
    return {
      items: page.map((row) => view(row, true)),
      nextCursor: rows.length > filter.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * Retention: deletes events older than 180 days in short batches within a time budget (the table trigger
   * refuses any younger row, so a bug here can't erase recent history). Returns the rows deleted.
   */
  public async purgeExpired(budgetMs = 60_000, batchSize = 5_000): Promise<number> {
    const started = Date.now();
    let deleted = 0;
    for (;;) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM security_events WHERE id IN (
          SELECT id FROM security_events
          WHERE created_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${SECURITY_EVENT_RETENTION_DAYS})
          ORDER BY created_at
          LIMIT ${batchSize}
        )`;
      deleted += count;
      if (count < batchSize || Date.now() - started > budgetMs) return deleted;
    }
  }
}
