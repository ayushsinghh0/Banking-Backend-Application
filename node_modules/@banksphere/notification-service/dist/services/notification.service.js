"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const client_1 = require("../generated/client");
const common_1 = require("@banksphere/common");
class NotificationService {
    prisma;
    emailProvider;
    dlqPublisher;
    maxRetries;
    constructor(prisma, emailProvider, dlqPublisher, maxRetries = 3) {
        this.prisma = prisma;
        this.emailProvider = emailProvider;
        this.dlqPublisher = dlqPublisher;
        this.maxRetries = maxRetries;
    }
    /**
     * Evaluates if a Kafka event was already processed to guarantee consumer idempotency
     */
    async isEventProcessed(eventId) {
        const existing = await this.prisma.processedEvent.findUnique({
            where: { eventId },
        });
        return !!existing;
    }
    /**
     * Marks an event as processed in the database
     */
    async markEventProcessed(eventId, eventType) {
        await this.prisma.processedEvent.create({
            data: { eventId, eventType },
        });
    }
    /**
     * Handles 'transaction.completed.v1' Kafka event idempotently
     */
    async handleTransactionCompleted(event) {
        if (await this.isEventProcessed(event.eventId)) {
            console.log(`[NotificationService] Duplicate event '${event.eventId}' skipped.`);
            return false;
        }
        const formattedAmount = common_1.MoneyUtil.formatINR(event.amountInPaise);
        const emailOptions = {
            recipient: 'customer@banksphere.com', // In production, resolved from customer service
            subject: `BankSphere Alert: ${event.type} of ${formattedAmount} Successful`,
            body: `Dear Customer,\n\nYour ${event.type} of ${formattedAmount} has been processed successfully.\n\nTransaction Reference: ${event.referenceId}\nTimestamp: ${event.timestamp}\n\nThank you for banking with BankSphere.`,
            metadata: { transactionId: event.transactionId, referenceId: event.referenceId },
        };
        await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, emailOptions);
        await this.markEventProcessed(event.eventId, event.eventType);
        return true;
    }
    /**
     * Handles 'account.created.v1' Kafka event idempotently
     */
    async handleAccountCreated(event) {
        if (await this.isEventProcessed(event.eventId)) {
            console.log(`[NotificationService] Duplicate event '${event.eventId}' skipped.`);
            return false;
        }
        const emailOptions = {
            recipient: 'customer@banksphere.com',
            subject: 'Welcome to BankSphere! Your New Account Details',
            body: `Dear Customer,\n\nYour new ${event.accountType} account has been successfully opened!\n\nAccount Number: ${event.accountNumber}\nCurrency: ${event.currency}\n\nThank you for choosing BankSphere.`,
            metadata: { accountId: event.accountId, accountNumber: event.accountNumber },
        };
        await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, emailOptions);
        await this.markEventProcessed(event.eventId, event.eventType);
        return true;
    }
    /**
     * Handles 'fraud.alert.created.v1' Kafka event idempotently
     */
    async handleFraudAlert(event) {
        if (await this.isEventProcessed(event.eventId)) {
            console.log(`[NotificationService] Duplicate event '${event.eventId}' skipped.`);
            return false;
        }
        const emailOptions = {
            recipient: 'security-team@banksphere.com',
            subject: `URGENT SECURITY ALERT: [${event.severity}] Risk Activity Detected`,
            body: `Security Operations Alert,\n\nA transaction has triggered risk rule evaluation.\n\nTransaction ID: ${event.transactionId}\nAccount ID: ${event.accountId}\nSeverity: ${event.severity}\nReason: ${event.reason}\n\nPlease review immediately.`,
            metadata: { alertId: event.alertId, transactionId: event.transactionId },
        };
        await this.dispatchWithRetryAndDLQ(event.eventId, event.eventType, emailOptions);
        await this.markEventProcessed(event.eventId, event.eventType);
        return true;
    }
    /**
     * Dispatches notifications with bounded exponential backoff retries and Dead-Letter Queue (DLQ) routing
     */
    async dispatchWithRetryAndDLQ(eventId, eventType, options) {
        let attempt = 0;
        let lastErrorMsg = '';
        while (attempt < this.maxRetries) {
            attempt++;
            try {
                await this.emailProvider.sendEmail(options);
                // Record successful dispatch
                await this.prisma.notificationLog.create({
                    data: {
                        recipient: options.recipient,
                        channel: client_1.NotificationChannel.EMAIL,
                        subject: options.subject,
                        body: options.body,
                        status: client_1.NotificationStatus.SENT,
                        retryCount: attempt - 1,
                        metadata: options.metadata,
                    },
                });
                return; // Success!
            }
            catch (err) {
                lastErrorMsg = err?.message || 'Email delivery failure';
                console.warn(`[NotificationService] Attempt ${attempt}/${this.maxRetries} failed: ${lastErrorMsg}`);
                if (attempt < this.maxRetries) {
                    // Exponential backoff delay: 100ms * 2^attempt
                    const backoffMs = 100 * Math.pow(2, attempt);
                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                }
            }
        }
        // RETRIES EXHAUSTED: Route to Dead-Letter Log & DLQ Topic
        console.error(`[NotificationService] Max retries exhausted for event '${eventId}'. Routing to Dead-Letter Queue.`);
        await this.prisma.notificationLog.create({
            data: {
                recipient: options.recipient,
                channel: client_1.NotificationChannel.EMAIL,
                subject: options.subject,
                body: options.body,
                status: client_1.NotificationStatus.DEAD_LETTER,
                retryCount: attempt,
                lastError: lastErrorMsg,
                metadata: options.metadata,
            },
        });
        if (this.dlqPublisher) {
            try {
                await this.dlqPublisher.publish('notifications.dlq', eventId, {
                    originalEventId: eventId,
                    originalEventType: eventType,
                    failureReason: lastErrorMsg,
                    payload: options,
                    failedAt: new Date().toISOString(),
                });
            }
            catch (dlqErr) {
                console.error('[NotificationService] Failed to publish message to DLQ topic', dlqErr);
            }
        }
    }
    /**
     * Queries notification history for audit
     */
    async getNotificationLogs(recipient, limit = 20) {
        return this.prisma.notificationLog.findMany({
            where: recipient ? { recipient } : undefined,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
}
exports.NotificationService = NotificationService;
