import { Mailer, renderEmail } from '@banksphere/common';
import { EmailDispatchOptions } from '../types';

export interface EmailProvider {
  sendEmail(options: EmailDispatchOptions): Promise<{ messageId: string }>;
}

/**
 * Production provider: renders the branded text + HTML email and sends it through the configured
 * Mailer (SMTP in production, see createMailerFromEnv).
 */
export class MailerEmailProvider implements EmailProvider {
  constructor(private readonly mailer: Mailer) {}

  public async sendEmail(options: EmailDispatchOptions): Promise<{ messageId: string }> {
    // The first paragraph is used as the greeting when it looks like one ("Dear Customer,")
    const paragraphs = options.body.split(/\n{2,}/);
    const greeting = /,$/.test(paragraphs[0] ?? '') ? paragraphs.shift() : undefined;
    const { text, html } = renderEmail({ greeting, paragraphs });
    return this.mailer.send({ to: options.recipient, subject: options.subject, text, html });
  }
}
