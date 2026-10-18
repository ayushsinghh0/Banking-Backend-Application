"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandlerMiddleware = errorHandlerMiddleware;
const zod_1 = require("zod");
const app_error_1 = require("../errors/app-error");
function errorHandlerMiddleware(err, req, res, _next) {
    const correlationId = req.correlationId || 'unknown-correlation-id';
    // Handled operational business errors
    if (err instanceof app_error_1.AppError) {
        if (req.log) {
            req.log.warn({ err, correlationId }, `Operational error: ${err.message}`);
        }
        res.status(err.statusCode).json({
            error: {
                code: err.errorCode,
                message: err.message,
                correlationId,
            },
        });
        return;
    }
    // Schema input validation errors (Zod)
    if (err instanceof zod_1.ZodError) {
        if (req.log) {
            req.log.warn({ issues: err.issues, correlationId }, 'Request schema validation failed');
        }
        res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid input parameters',
                details: err.issues.map((i) => ({
                    field: i.path.join('.'),
                    message: i.message,
                })),
                correlationId,
            },
        });
        return;
    }
    // Syntax error from malformed JSON bodies
    if ('type' in err && err.type === 'entity.parse.failed') {
        res.status(400).json({
            error: {
                code: 'MALFORMED_JSON',
                message: 'Request body contains invalid JSON',
                correlationId,
            },
        });
        return;
    }
    // Unhandled / programmer errors
    if (req.log) {
        req.log.error({ err, correlationId }, 'Unhandled server exception');
    }
    else {
        console.error(`[Unhandled Error] [Correlation: ${correlationId}]`, err);
    }
    res.status(500).json({
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected internal error occurred. Please contact support.',
            correlationId,
        },
    });
}
//# sourceMappingURL=error-handler.middleware.js.map