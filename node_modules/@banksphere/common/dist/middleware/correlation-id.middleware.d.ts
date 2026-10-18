import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/logger';
declare global {
    namespace Express {
        interface Request {
            correlationId: string;
            log: typeof logger;
        }
    }
}
export declare function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=correlation-id.middleware.d.ts.map