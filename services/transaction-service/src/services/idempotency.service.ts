import crypto from 'crypto';
import { PrismaClient, Prisma } from '../../generated/client';
import { IdempotencyConflictError, IdempotencyKeyReuseError } from '../errors';

export interface IdempotencyContext {
  userId: string;
  key: string;
  endpoint: string;
  requestHash: string;
}

export interface CachedResponse {
  statusCode: number;
  responseBody: any;
}

type TxClient = Prisma.TransactionClient;

/**
 * Idempotency for financial writes.
 *
 * The key is claimed by INSERTing a row inside the SAME database transaction that moves the money.
 * Because (user_id, key) is unique, a concurrent duplicate blocks on that insert until the first
 * transaction finishes: if it committed, the duplicate fails with a unique violation and replays the
 * stored response; if it rolled back, the duplicate proceeds. Money can therefore never move twice
 * for one key, and a crash can never leave a key stuck in "processing".
 */
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlHours = Number(process.env.IDEMPOTENCY_TTL_HOURS || 24)
  ) {}

  /**
   * Generates a deterministic SHA-256 hash of the request payload
   */
  public generateRequestHash(payload: Record<string, unknown>): string {
    const canonical = Object.keys(payload)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = payload[k];
        return acc;
      }, {});
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * Returns the stored response for a completed request with this key, or null if the key is unused.
   * Throws if the key was used for a different request.
   */
  public async findReplay(ctx: IdempotencyContext, client: PrismaClient | TxClient = this.prisma): Promise<CachedResponse | null> {
    const existing = await client.idempotencyRecord.findUnique({
      where: { userId_key: { userId: ctx.userId, key: ctx.key } },
    });

    if (!existing) return null;

    if (existing.expiresAt < new Date()) {
      await client.idempotencyRecord.deleteMany({ where: { id: existing.id } });
      return null;
    }

    if (existing.requestHash !== ctx.requestHash || existing.endpoint !== ctx.endpoint) {
      throw new IdempotencyKeyReuseError();
    }

    if (existing.status === 'COMPLETED' && existing.statusCode && existing.responseBody) {
      return { statusCode: existing.statusCode, responseBody: existing.responseBody };
    }

    return null;
  }

  /**
   * Claims the key inside the caller's transaction. Must be the first write in that transaction.
   */
  public async claim(tx: TxClient, ctx: IdempotencyContext): Promise<void> {
    await tx.idempotencyRecord.create({
      data: {
        userId: ctx.userId,
        key: ctx.key,
        endpoint: ctx.endpoint,
        requestHash: ctx.requestHash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() + this.ttlHours * 60 * 60 * 1000),
      },
    });
  }

  /**
   * Stores the final response inside the caller's transaction, so it commits atomically with the ledger writes.
   */
  public async complete(
    tx: TxClient,
    ctx: IdempotencyContext,
    statusCode: number,
    responseBody: unknown
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { userId_key: { userId: ctx.userId, key: ctx.key } },
      data: {
        status: 'COMPLETED',
        statusCode,
        responseBody: responseBody as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Runs `work` exactly once per (user, key): claims the key, executes the ledger writes and stores
   * the response in one DB transaction. Duplicates (sequential or concurrent) replay the stored response.
   */
  public async execute(
    ctx: IdempotencyContext,
    work: (tx: TxClient) => Promise<{ statusCode: number; data: unknown }>
  ): Promise<CachedResponse & { replayed: boolean }> {
    const replay = await this.findReplay(ctx);
    if (replay) return { ...replay, replayed: true };

    try {
      const { statusCode, body: responseBody } = await this.prisma.$transaction(
        async (tx) => {
          await this.claim(tx, ctx);
          const result = await work(tx);
          // Normalise to plain JSON (Dates -> ISO strings) so the replayed body is byte-identical
          const body = JSON.parse(JSON.stringify({ success: true, data: result.data }));
          await this.complete(tx, ctx, result.statusCode, body);
          return { statusCode: result.statusCode, body };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 15_000 }
      );
      return { statusCode, responseBody, replayed: false };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // A concurrent request with the same key committed first
        const winner = await this.findReplay(ctx);
        if (winner) return { ...winner, replayed: true };
        throw new IdempotencyConflictError();
      }
      throw err;
    }
  }

  public async purgeExpired(): Promise<number> {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}
