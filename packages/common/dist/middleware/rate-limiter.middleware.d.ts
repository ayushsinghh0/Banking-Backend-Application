import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
export interface RateLimiterOptions {
    windowMs: number;
    maxRequests: number;
    keyPrefix?: string;
    skipFailedRequests?: boolean;
}
export declare function createRateLimiter(redis: Redis, options: RateLimiterOptions): (req: Request, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=rate-limiter.middleware.d.ts.map