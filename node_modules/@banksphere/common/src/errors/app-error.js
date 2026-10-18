"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceUnavailableError = exports.BadGatewayError = exports.RateLimitExceededError = exports.InsufficientFundsError = exports.ConflictError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthorizedError = exports.BadRequestError = exports.AppError = void 0;
class AppError extends Error {
    isOperational;
    constructor(message, isOperational = true) {
        super(message);
        this.isOperational = isOperational;
        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
class BadRequestError extends AppError {
    statusCode = 400;
    errorCode = 'BAD_REQUEST';
    constructor(message = 'Invalid request parameters') {
        super(message);
    }
}
exports.BadRequestError = BadRequestError;
class UnauthorizedError extends AppError {
    statusCode = 401;
    errorCode = 'UNAUTHORIZED';
    constructor(message = 'Authentication required or invalid credentials') {
        super(message);
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ForbiddenError extends AppError {
    statusCode = 403;
    errorCode = 'FORBIDDEN';
    constructor(message = 'Access forbidden for current user permissions') {
        super(message);
    }
}
exports.ForbiddenError = ForbiddenError;
class NotFoundError extends AppError {
    statusCode = 404;
    errorCode = 'NOT_FOUND';
    constructor(message = 'Requested resource not found') {
        super(message);
    }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends AppError {
    statusCode = 409;
    errorCode = 'CONFLICT';
    constructor(message = 'Resource state conflict') {
        super(message);
    }
}
exports.ConflictError = ConflictError;
class InsufficientFundsError extends AppError {
    statusCode = 422;
    errorCode = 'INSUFFICIENT_FUNDS';
    constructor(message = 'Insufficient available balance to complete transaction') {
        super(message);
    }
}
exports.InsufficientFundsError = InsufficientFundsError;
class RateLimitExceededError extends AppError {
    statusCode = 429;
    errorCode = 'RATE_LIMIT_EXCEEDED';
    constructor(message = 'Too many requests, please slow down') {
        super(message);
    }
}
exports.RateLimitExceededError = RateLimitExceededError;
class BadGatewayError extends AppError {
    statusCode = 502;
    errorCode = 'BAD_GATEWAY';
    constructor(message = 'Upstream microservice failed to respond') {
        super(message);
    }
}
exports.BadGatewayError = BadGatewayError;
class ServiceUnavailableError extends AppError {
    statusCode = 503;
    errorCode = 'SERVICE_UNAVAILABLE';
    constructor(message = 'Service temporarily unavailable') {
        super(message);
    }
}
exports.ServiceUnavailableError = ServiceUnavailableError;
