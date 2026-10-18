"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FraudService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const client_1 = require("../generated/client");
const amount_threshold_rule_1 = require("../rules/amount-threshold.rule");
const velocity_rule_1 = require("../rules/velocity.rule");
class FraudService {
    prisma;
    alertPublisher;
    rules;
    constructor(prisma, alertPublisher, rules) {
        this.prisma = prisma;
        this.alertPublisher = alertPublisher;
        this.rules = rules || [
            new amount_threshold_rule_1.AmountThresholdRule(),
            new velocity_rule_1.VelocityRule(this.prisma),
        ];
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
     * Evaluates transaction risk across all configured rules
     */
    async evaluateTransaction(context, eventId) {
        // 1. Consumer Idempotency Check
        if (eventId && (await this.isEventProcessed(eventId))) {
            console.log(`[FraudService] Duplicate event '${eventId}' skipped.`);
            return {
                transactionId: context.transactionId,
                accountId: context.accountId,
                riskScore: 0,
                riskLevel: client_1.RiskLevel.LOW,
                triggeredRules: [],
                alertCreated: false,
            };
        }
        const triggeredRules = [];
        let totalScore = 0;
        // 2. Evaluate each rule in sequence
        for (const rule of this.rules) {
            const result = await rule.evaluate(context);
            if (result.triggered) {
                triggeredRules.push(result);
                totalScore += result.scoreContribution;
            }
        }
        const riskScore = Math.min(100, totalScore);
        // 3. Map score to RiskLevel
        let riskLevel = client_1.RiskLevel.LOW;
        if (riskScore >= 80) {
            riskLevel = client_1.RiskLevel.CRITICAL;
        }
        else if (riskScore >= 40) {
            riskLevel = client_1.RiskLevel.HIGH;
        }
        else if (riskScore >= 20) {
            riskLevel = client_1.RiskLevel.MEDIUM;
        }
        // 4. Record Risk Assessment in database
        await this.prisma.riskAssessment.create({
            data: {
                transactionId: context.transactionId,
                accountId: context.accountId,
                amountInPaise: context.amountInPaise,
                riskScore,
                riskLevel,
                triggeredRules: triggeredRules,
                assessedAt: context.timestamp,
            },
        });
        let alertCreated = false;
        let alertId;
        // 5. If High or Critical risk: raise FraudAlert and publish event
        if (riskLevel === client_1.RiskLevel.HIGH || riskLevel === client_1.RiskLevel.CRITICAL) {
            const reasons = triggeredRules.map((r) => r.reason).join(' | ');
            const alert = await this.prisma.fraudAlert.create({
                data: {
                    transactionId: context.transactionId,
                    accountId: context.accountId,
                    severity: riskLevel,
                    reason: reasons || 'Multiple risk anomalies detected',
                    status: client_1.AlertStatus.OPEN,
                },
            });
            alertCreated = true;
            alertId = alert.id;
            // Publish fraud.alert.created.v1 to Kafka for Notification & Audit
            if (this.alertPublisher) {
                const alertEvent = {
                    eventId: crypto_1.default.randomUUID(),
                    eventType: 'fraud.alert.created.v1',
                    timestamp: new Date().toISOString(),
                    alertId: alert.id,
                    transactionId: alert.transactionId,
                    accountId: alert.accountId,
                    severity: alert.severity,
                    reason: alert.reason,
                };
                try {
                    await this.alertPublisher.publish('fraud.alert.created.v1', alert.accountId, alertEvent);
                }
                catch (err) {
                    console.error('[FraudService] Failed to emit fraud.alert.created.v1 to Kafka', err);
                }
            }
        }
        // 6. Record processed_events to prevent duplicate processing
        if (eventId) {
            await this.prisma.processedEvent.create({
                data: { eventId, eventType: 'transaction.completed.v1' },
            });
        }
        return {
            transactionId: context.transactionId,
            accountId: context.accountId,
            riskScore,
            riskLevel,
            triggeredRules,
            alertCreated,
            alertId,
        };
    }
    /**
     * Retrieves active open fraud alerts for compliance officers
     */
    async getAlerts(status, limit = 20) {
        return this.prisma.fraudAlert.findMany({
            where: status ? { status } : undefined,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
}
exports.FraudService = FraudService;
