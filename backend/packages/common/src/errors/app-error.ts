export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorCode: string;
  public readonly isOperational: boolean;

  constructor(message: string, isOperational = true) {
    super(message);
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly errorCode = 'BAD_REQUEST';
  constructor(message = 'Invalid request parameters') {
    super(message);
  }
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly errorCode = 'UNAUTHORIZED';
  constructor(message = 'Authentication required or invalid credentials') {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly errorCode = 'FORBIDDEN';
  constructor(message = 'Access forbidden for current user permissions') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly errorCode = 'NOT_FOUND';
  constructor(message = 'Requested resource not found') {
    super(message);
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly errorCode = 'CONFLICT';
  constructor(message = 'Resource state conflict') {
    super(message);
  }
}

export class InsufficientFundsError extends AppError {
  readonly statusCode = 422;
  readonly errorCode = 'INSUFFICIENT_FUNDS';
  constructor(message = 'Insufficient available balance to complete transaction') {
    super(message);
  }
}

export class RateLimitExceededError extends AppError {
  readonly statusCode = 429;
  readonly errorCode = 'RATE_LIMIT_EXCEEDED';
  constructor(message = 'Too many requests, please slow down') {
    super(message);
  }
}

export class BadGatewayError extends AppError {
  readonly statusCode = 502;
  readonly errorCode = 'BAD_GATEWAY';
  constructor(message = 'Upstream microservice failed to respond') {
    super(message);
  }
}

export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly errorCode = 'SERVICE_UNAVAILABLE';
  constructor(message = 'Service temporarily unavailable') {
    super(message);
  }
}

/**
 * Operational error with an explicit status and machine-readable code, for cases that don't
 * warrant a dedicated class (e.g. EMAIL_NOT_VERIFIED, INVALID_OR_EXPIRED_TOKEN).
 */
export class HttpError extends AppError {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}
