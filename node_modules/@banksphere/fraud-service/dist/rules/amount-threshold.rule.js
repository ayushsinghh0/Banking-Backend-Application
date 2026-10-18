"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmountThresholdRule = void 0;
const client_1 = require("../generated/client");
const common_1 = require("@banksphere/common");
class AmountThresholdRule {
    thresholdPaise;
    id = 'RULE_AMOUNT_THRESHOLD';
    name = 'High Monetary Amount Threshold Rule';
    constructor(thresholdPaise = 20000000n // Default: ₹2,00,000.00
    ) {
        this.thresholdPaise = thresholdPaise;
    }
    async evaluate(context) {
        const isExceeded = context.amountInPaise >= this.thresholdPaise;
        if (isExceeded) {
            const formattedAmount = common_1.MoneyUtil.formatINR(context.amountInPaise);
            const formattedThreshold = common_1.MoneyUtil.formatINR(this.thresholdPaise);
            return {
                ruleId: this.id,
                ruleName: this.name,
                triggered: true,
                scoreContribution: 45,
                severity: client_1.RiskLevel.HIGH,
                reason: `Transaction amount ${formattedAmount} exceeds threshold limit of ${formattedThreshold}`,
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
exports.AmountThresholdRule = AmountThresholdRule;
