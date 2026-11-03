import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
// pino-pretty runs in a worker thread; under test (fake timers) it can keep Jest from exiting, so tests log plain JSON
const prettyLogs = !isProduction && process.env.NODE_ENV !== 'test' && process.env.LOG_PRETTY !== 'false';

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
  transport: !prettyLogs
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

const EMAIL_ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})/g;

/**
 * Replaces the local part of every email address in free text (SMTP rejections, error messages) with ***,
 * keeping the domain for troubleshooting: "<alice@bank.com>: mailbox full" -> "<***@bank.com>: mailbox full".
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_ADDRESS, '***@$1');
}

/**
 * A loggable copy of an error without personal data: message and stack with email addresses redacted,
 * and only the diagnostic fields (code, SMTP response code/command). Fields such as nodemailer's
 * `response`, `rejected` or `envelope` (which carry recipient addresses) are dropped.
 */
export function redactErrorForLog(err: unknown): unknown {
  if (typeof err === 'string') return redactEmails(err);
  if (!(err instanceof Error)) return err;
  const e = err as Error & { code?: unknown; responseCode?: unknown; command?: unknown };
  return {
    type: e.constructor?.name || 'Error',
    message: redactEmails(String(e.message ?? '')),
    ...(typeof e.code === 'string' || typeof e.code === 'number' ? { code: e.code } : {}),
    ...(typeof e.responseCode === 'number' ? { responseCode: e.responseCode } : {}),
    ...(typeof e.command === 'string' ? { command: redactEmails(e.command) } : {}),
    ...(e.stack ? { stack: redactEmails(e.stack) } : {}),
  };
}
