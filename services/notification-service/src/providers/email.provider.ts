import { EmailDispatchOptions } from '../types';

export interface EmailProvider {
  sendEmail(options: EmailDispatchOptions): Promise<{ messageId: string }>;
}

export class SimulatedEmailProvider implements EmailProvider {
  private shouldFailNext = false;

  /**
   * For testing retries and DLQ: configure the provider to simulate a network outage
   */
  public simulateFailure(fail: boolean): void {
    this.shouldFailNext = fail;
  }

  public async sendEmail(options: EmailDispatchOptions): Promise<{ messageId: string }> {
    if (this.shouldFailNext) {
      throw new Error('SMTP Connection Timeout: Remote mail server unreachable');
    }

    const messageId = `msg-${Date.now()}-${Math.random().toString(16).substring(2, 8)}`;

    console.log('\n================== [SIMULATED EMAIL DISPATCH] ==================');
    console.log(`To:      ${options.recipient}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`Date:    ${new Date().toISOString()}`);
    console.log('----------------------------------------------------------------');
    console.log(options.body);
    console.log('================================================================\n');

    return { messageId };
  }
}
