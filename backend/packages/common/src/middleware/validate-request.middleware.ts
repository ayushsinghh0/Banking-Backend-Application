import { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

export function validateRequest(schema: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }
      if (schema.query) {
        req.query = (await schema.query.parseAsync(req.query)) as Request['query'];
      }
      if (schema.params) {
        req.params = (await schema.params.parseAsync(req.params)) as Request['params'];
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
