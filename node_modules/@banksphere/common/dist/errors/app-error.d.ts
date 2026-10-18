export declare abstract class AppError extends Error {
    abstract readonly statusCode: number;
    abstract readonly errorCode: string;
    readonly isOperational: boolean;
    constructor(message: string, isOperational?: boolean);
}
export declare class BadRequestError extends AppError {
    readonly statusCode = 400;
    readonly errorCode = "BAD_REQUEST";
    constructor(message?: string);
}
export declare class UnauthorizedError extends AppError {
    readonly statusCode = 401;
    readonly errorCode = "UNAUTHORIZED";
    constructor(message?: string);
}
export declare class ForbiddenError extends AppError {
    readonly statusCode = 403;
    readonly errorCode = "FORBIDDEN";
    constructor(message?: string);
}
export declare class NotFoundError extends AppError {
    readonly statusCode = 404;
    readonly errorCode = "NOT_FOUND";
    constructor(message?: string);
}
export declare class ConflictError extends AppError {
    readonly statusCode = 409;
    readonly errorCode = "CONFLICT";
    constructor(message?: string);
}
export declare class InsufficientFundsError extends AppError {
    readonly statusCode = 422;
    readonly errorCode = "INSUFFICIENT_FUNDS";
    constructor(message?: string);
}
export declare class RateLimitExceededError extends AppError {
    readonly statusCode = 429;
    readonly errorCode = "RATE_LIMIT_EXCEEDED";
    constructor(message?: string);
}
export declare class BadGatewayError extends AppError {
    readonly statusCode = 502;
    readonly errorCode = "BAD_GATEWAY";
    constructor(message?: string);
}
export declare class ServiceUnavailableError extends AppError {
    readonly statusCode = 503;
    readonly errorCode = "SERVICE_UNAVAILABLE";
    constructor(message?: string);
}
//# sourceMappingURL=app-error.d.ts.map