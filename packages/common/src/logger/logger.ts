import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
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
      'accessToken',
      '*.accessToken',
      'passwordHash',
      '*.passwordHash',
      'req.headers["x-internal-service-token"]',
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

export type Logger = typeof logger;
