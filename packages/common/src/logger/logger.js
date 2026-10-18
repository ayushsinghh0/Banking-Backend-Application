"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const pino_1 = __importDefault(require("pino"));
const isProduction = process.env.NODE_ENV === 'production';
exports.logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    redact: {
        paths: [
            'password',
            '*.password',
            'token',
            '*.token',
            'refreshToken',
            '*.refreshToken',
            'pin',
            'cvv',
            'cardNumber',
            'req.headers.authorization',
            'req.headers.cookie',
        ],
        censor: '[REDACTED_FINANCIAL_SECRET]',
    },
    transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
});
