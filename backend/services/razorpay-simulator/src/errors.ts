import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export interface RazorpayErrorDetail {
  source?: string;
  step?: string;
  reason?: string;
  field?: string;
}

/**
 * Razorpay answers every refusal with `{ error: { code, description, source, step, reason, metadata } }`
 * (400 for anything wrong with the request, including unknown ids; 401 for bad credentials). The payment
 * service's client maps that shape, so the simulator must speak it exactly rather than the platform's own
 * `{ error: { code, message } }`.
 */
export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'BAD_REQUEST_ERROR' | 'SERVER_ERROR',
    readonly description: string,
    readonly detail: RazorpayErrorDetail = {}
  ) {
    super(description);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        description: this.description,
        source: this.detail.source ?? 'NA',
        step: this.detail.step ?? 'NA',
        reason: this.detail.reason ?? 'NA',
        metadata: {},
        ...(this.detail.field ? { field: this.detail.field } : {}),
      },
    };
  }
}

const BUSINESS = { source: 'business', step: 'payment_initiation' };

export const RazorpayErrors = {
  unauthorized: () => new RazorpayError(401, 'BAD_REQUEST_ERROR', 'The api key/secret provided is invalid'),
  notFound: () => new RazorpayError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist', { ...BUSINESS, reason: 'input_validation_failed' }),
  invalid: (description: string, field?: string) =>
    new RazorpayError(400, 'BAD_REQUEST_ERROR', description, { ...BUSINESS, reason: 'input_validation_failed', field }),
  refused: (description: string) => new RazorpayError(400, 'BAD_REQUEST_ERROR', description, { ...BUSINESS }),
  unknownRoute: () => new RazorpayError(404, 'BAD_REQUEST_ERROR', 'The requested URL was not found on the server'),
};

export function razorpayErrorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof RazorpayError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.map(String).join('.') || undefined;
    res.status(400).json(RazorpayErrors.invalid(field ? `${field}: ${first.message}` : first?.message ?? 'Invalid request', field).toJSON());
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json(RazorpayErrors.invalid('The request body is not valid JSON').toJSON());
    return;
  }
  (req.log ?? console).error({ err }, 'Simulator request failed');
  res
    .status(500)
    .json(new RazorpayError(500, 'SERVER_ERROR', 'We are facing some trouble completing your request at the moment. Please try again shortly.').toJSON());
}
