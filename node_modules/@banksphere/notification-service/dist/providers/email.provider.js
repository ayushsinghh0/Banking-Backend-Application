"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimulatedEmailProvider = void 0;
class SimulatedEmailProvider {
    shouldFailNext = false;
    /**
     * For testing retries and DLQ: configure the provider to simulate a network outage
     */
    simulateFailure(fail) {
        this.shouldFailNext = fail;
    }
    async sendEmail(options) {
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
exports.SimulatedEmailProvider = SimulatedEmailProvider;
