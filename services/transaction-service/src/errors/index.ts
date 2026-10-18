export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorCode: string;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly errorCode = 'NOT_FOUND';

  constructor(message: string = 'Resource not found') {
    super(message);
  }
}

export class InsufficientFundsError extends AppError {
  readonly statusCode = 422;
  readonly errorCode = 'INSUFFICIENT_FUNDS';

  constructor(message: string = 'Insufficient available balance to complete the transaction') {
    super(message);
  }
}

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

export class InvalidAmountError extends AppError {
  readonly statusCode = 400;
  readonly errorCode = 'INVALID_AMOUNT';

  constructor(message: string = 'Transaction amount must be a positive integer in minor units (paise)') {
    super(message);
  }
}
