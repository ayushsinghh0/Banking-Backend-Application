import { HttpError, NotFoundError, RateLimitExceededError } from '@banksphere/common';

/** Refused for sending too quickly; the controller turns `retryAfterSeconds` into the Retry-After header */
export class MessageRateLimitedError extends RateLimitExceededError {
  constructor(readonly retryAfterSeconds: number) {
    super('You’re sending messages too quickly. Please wait a moment and try again.');
  }
}

/** The service's HTTP refusals, with the codes the web app explains to the user */
export const AssistantErrors = {
  conversationNotFound: () => new NotFoundError('Conversation not found'),
  emptyMessage: () => new HttpError(400, 'VALIDATION_ERROR', 'content must not be empty'),
  messageTooLong: (max: number) => new HttpError(400, 'MESSAGE_TOO_LONG', `Messages can be at most ${max} characters`),
  tokenBudgetExceeded: () => new HttpError(429, 'TOKEN_BUDGET_EXCEEDED', 'You’ve used today’s Sphere allowance. It resets at midnight India time.'),
  /** A model failure after the answer had started (JSON mode only; a stream reports it in-band) */
  answerFailed: (code: string, message: string) => new HttpError(503, code, message),
};
