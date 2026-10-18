"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VelocityRule = void 0;
const client_1 = require("../generated/client");
class VelocityRule {
    prisma;
    windowSeconds;
    maxTransactions;
    id = 'RULE_VELOCITY_CHECK';
    name = 'Transaction Velocity Surge Rule';
    constructor(prisma, windowSeconds = 60, maxTransactions = 3) {
        this.prisma = prisma;
        this.windowSeconds = windowSeconds;
        this.maxTransactions = maxTransactions;
    }
    async evaluate(context) {
        const windowStart = new Date(context.timestamp.getTime() - this.windowSeconds * 1000);
        // Count recent risk assessments for this account within the sliding time window
        const recentCount = await this.prisma.riskAssessment.count({
            where: {
                accountId: context.accountId,
                assessedAt: { gte: windowStart },
            },
        });
        if (recentCount >= this.maxTransactions) {
            return {
                ruleId: this.id,
                ruleName: this.name,
                triggered: true,
                scoreContribution: 40,
                severity: client_1.RiskLevel.HIGH,
                reason: `Excessive transaction frequency: ${recentCount + 1} transactions recorded within ${this.windowSeconds}s`,
            };
        }
        return {
            ruleId: this.id,
            ruleName: this.name,
            triggered: false,
            scoreContribution: 0,
            severity: client_1.RiskLevel.LOW,
        };
    }
}
exports.VelocityRule = VelocityRule;
