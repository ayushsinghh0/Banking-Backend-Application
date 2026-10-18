"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const errors_1 = require("../errors");
class IdempotencyService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    /**
     * Generates a deterministic SHA-256 hash of the request payload
     */
    generateRequestHash(payload) {
        const serialized = JSON.stringify(payload, Object.keys(payload || {}).sort());
        return crypto_1.default.createHash('sha256').update(serialized).digest('hex');
    }
    /**
     * Evaluates or locks the idempotency key.
     * If a completed request exists, returns the previous cached response.
     * If an in-flight request exists or hash mismatch occurs, throws conflict error.
     */
    async acquireKey(key, endpoint, requestHash, ttlMinutes = 60) {
        const existing = await this.prisma.idempotencyRecord.findUnique({
            where: { key },
        });
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new errors_1.IdempotencyConflictError(`Idempotency-Key '${key}' was previously used with a different request payload.`);
            }
            if (existing.status === 'PROCESSING') {
                throw new errors_1.IdempotencyConflictError(`A request with Idempotency-Key '${key}' is currently being processed. Please retry shortly.`);
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
    async completeKey(key, statusCode, responseBody, txClient) {
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
    async failKey(key, txClient) {
        const client = txClient || this.prisma;
        await client.idempotencyRecord.updateMany({
            where: { key, status: 'PROCESSING' },
            data: { status: 'FAILED' },
        });
    }
}
exports.IdempotencyService = IdempotencyService;
