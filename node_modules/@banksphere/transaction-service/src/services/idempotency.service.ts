import crypto from 'crypto';
import { PrismaClient } from '../generated/client';
import { IdempotencyConflictError } from '../errors';

export interface IdempotencyCheckResult {
  isCached: boolean;
  statusCode?: number;
  responseBody?: any;
}

export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generates a deterministic SHA-256 hash of the request payload
   */
  public generateRequestHash(payload: unknown): string {
    const serialized = JSON.stringify(payload, Object.keys(payload || {}).sort());
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Evaluates or locks the idempotency key.
   * If a completed request exists, returns the previous cached response.
   * If an in-flight request exists or hash mismatch occurs, throws conflict error.
   */
  public async acquireKey(
    key: string,
    endpoint: string,
    requestHash: string,
    ttlMinutes = 60
  ): Promise<IdempotencyCheckResult> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(
          `Idempotency-Key '${key}' was previously used with a different request payload.`
        );
      }

      if (existing.status === 'PROCESSING') {
        throw new IdempotencyConflictError(
          `A request with Idempotency-Key '${key}' is currently being processed. Please retry shortly.`
        );
      }

      if (existing.status === 'COMPLETED' && existing.statusCode && existing.responseBody) {
        return {
          isCached: true,
          statusCode: existing.statusCode,
          responseBody: existing.responseBody,
        };
      }
    }

    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // Create the idempotency record in 'PROCESSING' state
    await this.prisma.idempotencyRecord.upsert({
      where: { key },
      create: {
        key,
        endpoint,
        requestHash,
        status: 'PROCESSING',
        expiresAt,
      },
      update: {
        status: 'PROCESSING',
        requestHash,
        expiresAt,
      },
    });

    return { isCached: false };
  }

  /**
   * Persists the final successful response for the idempotency key
   */
  public async completeKey(
    key: string,
    statusCode: number,
    responseBody: any,
    txClient?: any
  ): Promise<void> {
    const client = txClient || this.prisma;
    await client.idempotencyRecord.update({
      where: { key },
      data: {
        status: 'COMPLETED',
        statusCode,
        responseBody,
      },
    });
  }

  /**
   * Releases or marks key as failed if the operation encounters an abortive error
   */
  public async failKey(key: string, txClient?: any): Promise<void> {
    const client = txClient || this.prisma;
    await client.idempotencyRecord.updateMany({
      where: { key, status: 'PROCESSING' },
      data: { status: 'FAILED' },
    });
  }
}
