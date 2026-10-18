import { Request, Response, NextFunction } from 'express';
import { AnyZodObject } from 'zod';
export declare function validateRequest(schema: {
    body?: AnyZodObject;
    query?: AnyZodObject;
    params?: AnyZodObject;
}): (req: Request, _res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=validate-request.middleware.d.ts.map