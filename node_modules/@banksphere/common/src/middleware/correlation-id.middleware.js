"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correlationIdMiddleware = correlationIdMiddleware;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../logger/logger");
function correlationIdMiddleware(req, res, next) {
    const correlationId = req.header('x-correlation-id') || crypto_1.default.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    // Attach a contextual child logger with correlation ID bound
    req.log = logger_1.logger.child({ correlationId });
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        req.log.info({
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            durationMs: duration,
        }, 'HTTP Request completed');
    });
    next();
}
