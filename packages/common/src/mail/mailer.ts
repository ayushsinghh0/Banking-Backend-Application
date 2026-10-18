import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../logger/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(
    private readonly from: string,
    options: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
      requireTls?: boolean;
    }
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.requireTls,
      auth: options.user ? { user: options.user, pass: options.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  public async send(message: MailMessage): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({ from: this.from, ...message });
    return { messageId: info.messageId };
  }

  public async verify(): Promise<void> {
    await this.transporter.verify();
  }
}

/**
 * Development-only transport: logs that an email was sent without its body, since bodies can
 * contain one-time secrets (reset / verification links). Refused in production.
 */
export class ConsoleMailer implements Mailer {
  public readonly sent: MailMessage[] = [];

  public async send(message: MailMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    logger.info({ to: message.to, subject: message.subject }, '[ConsoleMailer] email not delivered (EMAIL_TRANSPORT=console)');
    return { messageId: `console-${Date.now()}` };
  }
}

/**
 * EMAIL_TRANSPORT=smtp (default) uses SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASSWORD/MAIL_FROM.
 * EMAIL_TRANSPORT=console is only allowed outside production.
 */
export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const transport = env.EMAIL_TRANSPORT || 'smtp';
  if (transport === 'console') {
    if (env.NODE_ENV === 'production') {
      throw new Error('EMAIL_TRANSPORT=console is not allowed in production');
    }
    return new ConsoleMailer();
  }
  if (transport !== 'smtp') {
    throw new Error(`Unsupported EMAIL_TRANSPORT '${transport}'`);
  }
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    throw new Error('SMTP_HOST and MAIL_FROM must be set when EMAIL_TRANSPORT=smtp');
  }
  const port = Number(env.SMTP_PORT || 587);
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  return new SmtpMailer(env.MAIL_FROM, {
    host: env.SMTP_HOST,
    port,
    secure,
    user: env.SMTP_USER || undefined,
    password: env.SMTP_PASSWORD || undefined,
    // Unless explicitly disabled, refuse to send credentials or secrets over an unencrypted connection
    requireTls: !secure && env.SMTP_REQUIRE_TLS !== 'false',
  });
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Renders a simple branded email in both text and HTML. All dynamic values are escaped.
 */
export function renderEmail(content: {
  greeting?: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footer?: string;
}): { text: string; html: string } {
  const greeting = content.greeting ?? 'Dear Customer,';
  const footer =
    content.footer ??
    'If you did not request this, please contact BankSphere support immediately. BankSphere will never ask for your password.';

  const text = [
    greeting,
    '',
    ...content.paragraphs.flatMap((p) => [p, '']),
    ...(content.action ? [`${content.action.label}: ${content.action.url}`, ''] : []),
    footer,
    '',
    '— BankSphere',
  ].join('\n');

  const action = content.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="background:#0b5cad;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(content.action.label)}</a></p>
       <p style="font-size:12px;color:#555">Or paste this link into your browser:<br>${escapeHtml(content.action.url)}</p>`
    : '';

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">
<h2 style="color:#0b5cad;margin-top:0">BankSphere</h2>
<p>${escapeHtml(greeting)}</p>
${content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${action}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#555">${escapeHtml(footer)}</p>
</body></html>`;

  return { text, html };
}
