import Redis from 'ioredis';
export declare class RedisService {
    private client;
    private readonly redisUrl;
    constructor(redisUrl?: string);
    getClient(): Redis;
    ping(): Promise<boolean>;
    disconnect(): Promise<void>;
}
export declare const defaultRedisService: RedisService;
//# sourceMappingURL=redis-client.d.ts.map