import { toast } from 'sonner';
import { describeError } from './api/errors';

/** Toast for an API error, with the support reference for unexpected failures */
export function notifyError(error: unknown, fallbackTitle?: string): void {
  const { title, description, reference } = describeError(error);
  toast.error(fallbackTitle && title === 'Something went wrong' ? fallbackTitle : title, {
    description: reference ? `${description} (Ref: ${reference})` : description,
  });
}

export function notifySuccess(title: string, description?: string): void {
  toast.success(title, description ? { description } : undefined);
}

/** A fresh Idempotency-Key for one money-moving intent (reuse it when retrying that same intent) */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
