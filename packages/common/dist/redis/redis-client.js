"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultRedisService = exports.RedisService = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../logger/logger");
class RedisService {
    client = null;
    redisUrl;
    constructor(redisUrl) {
        this.redisUrl = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    }
    getClient() {
        if (!this.client) {
            this.client = new ioredis_1.default(this.redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy(times) {
                    const delay = Math.min(times * 100, 3000);
                    return delay;
                },
                reconnectOnError(err) {
                    logger_1.logger.warn({ err }, 'Redis connection error, reconnecting...');
                    return true;
                },
            });
            this.client.on('connect', () => {
                logger_1.logger.info('Connected to Redis');
            });
            this.client.on('error', (err) => {
                logger_1.logger.error({ err }, 'Redis client runtime error');
            });
        }
        return this.client;
    }
    async ping() {
        try {
            const res = await this.getClient().ping();
            return res === 'PONG';
        }
        catch {
            return false;
        }
    }
    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
        }
    }
}
exports.RedisService = RedisService;
exports.defaultRedisService = new RedisService();
//# sourceMappingURL=redis-client.js.map