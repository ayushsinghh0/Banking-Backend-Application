"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidAmountError = exports.IdempotencyConflictError = exports.SameAccountTransferError = exports.AccountInactiveError = exports.InsufficientFundsError = exports.NotFoundError = exports.AppError = void 0;
class AppError extends Error {
    constructor(message) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.AppError = AppError;
class NotFoundError extends AppError {
    statusCode = 404;
    errorCode = 'NOT_FOUND';
    constructor(message = 'Resource not found') {
        super(message);
    }
}
exports.NotFoundError = NotFoundError;
class InsufficientFundsError extends AppError {
    statusCode = 422;
    errorCode = 'INSUFFICIENT_FUNDS';
    constructor(message = 'Insufficient available balance to complete the transaction') {
        super(message);
    }
}
exports.InsufficientFundsError = InsufficientFundsError;
class AccountInactiveError extends AppError {
    statusCode = 403;
    errorCode = 'ACCOUNT_INACTIVE';
    constructor(message = 'One or more accounts involved in this transaction are inactive or frozen') {
        super(message);
    }
}
exports.AccountInactiveError = AccountInactiveError;
class SameAccountTransferError extends AppError {
    statusCode = 400;
    errorCode = 'SAME_ACCOUNT_TRANSFER';
    constructor(message = 'Source and destination accounts cannot be identical') {
        super(message);
    }
}
exports.SameAccountTransferError = SameAccountTransferError;
class IdempotencyConflictError extends AppError {
    statusCode = 409;
    errorCode = 'IDEMPOTENCY_CONFLICT';
    constructor(message = 'A request with this Idempotency-Key is currently being processed or payload differs') {
        super(message);
    }
}
exports.IdempotencyConflictError = IdempotencyConflictError;
class InvalidAmountError extends AppError {
    statusCode = 400;
    errorCode = 'INVALID_AMOUNT';
    constructor(message = 'Transaction amount must be a positive integer in minor units (paise)') {
        super(message);
    }
}
exports.InvalidAmountError = InvalidAmountError;
