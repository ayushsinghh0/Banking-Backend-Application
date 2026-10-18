import { IRiskRule } from './risk-rule.interface';
import { TransactionEvaluationContext, RiskRuleResult } from '../types';
import { RiskLevel } from '../../generated/client';
import { MoneyUtil } from '@banksphere/common';

export class AmountThresholdRule implements IRiskRule {
  readonly id = 'RULE_AMOUNT_THRESHOLD';
  readonly name = 'High Monetary Amount Threshold Rule';

  constructor(
    private readonly thresholdPaise: bigint = 20000000n // Default: ₹2,00,000.00
  ) {}

  public async evaluate(context: TransactionEvaluationContext): Promise<RiskRuleResult> {
    const isExceeded = context.amountInPaise >= this.thresholdPaise;

    if (isExceeded) {
      const formattedAmount = MoneyUtil.formatINR(context.amountInPaise);
      const formattedThreshold = MoneyUtil.formatINR(this.thresholdPaise);
      return {
        ruleId: this.id,
        ruleName: this.name,
        triggered: true,
        scoreContribution: 45,
        severity: RiskLevel.HIGH,
        reason: `Transaction amount ${formattedAmount} exceeds threshold limit of ${formattedThreshold}`,
      };
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      triggered: false,
      scoreContribution: 0,
      severity: RiskLevel.LOW,
    };
  }
}
