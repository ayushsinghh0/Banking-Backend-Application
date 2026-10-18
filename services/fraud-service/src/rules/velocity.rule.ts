import { IRiskRule } from './risk-rule.interface';
import { TransactionEvaluationContext, RiskRuleResult } from '../types';
import { PrismaClient, RiskLevel } from '../../generated/client';

export class VelocityRule implements IRiskRule {
  readonly id = 'RULE_VELOCITY_CHECK';
  readonly name = 'Transaction Velocity Surge Rule';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly windowSeconds = 60,
    private readonly maxTransactions = 3
  ) {}

  public async evaluate(context: TransactionEvaluationContext): Promise<RiskRuleResult> {
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
        severity: RiskLevel.HIGH,
        reason: `Excessive transaction frequency: ${recentCount + 1} transactions recorded within ${this.windowSeconds}s`,
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
