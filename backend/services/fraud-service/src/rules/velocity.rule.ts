import { IRiskRule } from './risk-rule.interface';
import { TransactionEvaluationContext, RiskRuleResult } from '../types';
import { PrismaClient, RiskLevel } from '../../generated/client';

export const VELOCITY_RULE_ID = 'RULE_VELOCITY_CHECK';

export class VelocityRule implements IRiskRule {
  readonly id = VELOCITY_RULE_ID;
  readonly name = 'Transaction Velocity Surge Rule';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly windowSeconds = 60,
    private readonly maxTransactions = 3
  ) {}

  public async evaluate(context: TransactionEvaluationContext): Promise<RiskRuleResult> {
    const windowStart = new Date(context.timestamp.getTime() - this.windowSeconds * 1000);

    // Count risk assessments for this account in the window ENDING at this transaction: an event evaluated
    // late (consumer lag, retry, replay) must not count transactions that happened after it.
    // Served by risk_assessments(account_id, assessed_at).
    const recentCount = await this.prisma.riskAssessment.count({
      where: {
        accountId: context.accountId,
        assessedAt: { gte: windowStart, lte: context.timestamp },
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
