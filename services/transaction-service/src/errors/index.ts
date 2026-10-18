// Ledger-specific errors extend the shared AppError so the common error handler maps them
// to their real HTTP status instead of a generic 500.
import { AppError } from '@banksphere/common';

export { AppError, NotFoundError, InsufficientFundsError, ForbiddenError } from '@banksphere/common';

export class AccountInactiveError extends AppError {
  readonly statusCode = 403;
  readonly errorCode = 'ACCOUNT_INACTIVE';

  constructor(message: string = 'One or more accounts involved in this transaction are inactive or frozen') {
    super(message);
  }
}

export class SameAccountTransferError extends AppError {
  readonly statusCode = 400;
  readonly errorCode = 'SAME_ACCOUNT_TRANSFER';

  constructor(message: string = 'Source and destination accounts cannot be identical') {
    super(message);
  }
}

export class IdempotencyConflictError extends AppError {
  readonly statusCode = 409;
  readonly errorCode = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string = 'A request with this Idempotency-Key is currently being processed or payload differs') {
    super(message);
  }
}

export class IdempotencyKeyReuseError extends AppError {
  readonly statusCode = 422;
  readonly errorCode = 'IDEMPOTENCY_KEY_REUSED';

  constructor(message: string = 'This Idempotency-Key was already used with a different request') {
    super(message);
  }
}

export class InvalidAmountError extends AppError {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_AMOUNT';

  constructor(message: string = 'Transaction amount must be a positive integer in minor units (paise)') {
    super(message);
  }
}

export class DailyLimitExceededError extends AppError {
  readonly statusCode = 422;
  readonly errorCode = 'DAILY_LIMIT_EXCEEDED';

  constructor(message: string = 'This transaction would exceed the account daily outgoing limit') {
    super(message);
  }
}

export class CurrencyMismatchError extends AppError {
  readonly statusCode = 400;
  readonly errorCode = 'CURRENCY_MISMATCH';

  constructor(message: string = 'Source and destination accounts use different currencies') {
    super(message);
  }
}
