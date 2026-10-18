import { IRiskRule } from './risk-rule.interface';
import { TransactionEvaluationContext, RiskRuleResult } from '../types';
import { PrismaClient, RiskLevel } from '../../generated/client';

/**
 * Flags "structuring": a teller (or customer) repeatedly moving cash just under the single-approval
 * limit to avoid the maker-checker control. Triggers when the same initiator records several cash
 * operations at or above `nearLimitRatio` of the limit within 24 hours.
 */
export class CashStructuringRule implements IRiskRule {
  readonly id = 'RULE_CASH_STRUCTURING';
  readonly name = 'Cash structuring below approval limit';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly singleApprovalLimit = BigInt(process.env.CASH_SINGLE_APPROVAL_LIMIT_PAISE || '20000000'),
    private readonly nearLimitRatioPercent = 80n,
    private readonly maxNearLimitOps = Number(process.env.STRUCTURING_MAX_OPS || 2)
  ) {}

  public async evaluate(context: TransactionEvaluationContext): Promise<RiskRuleResult> {
    const threshold = (this.singleApprovalLimit * this.nearLimitRatioPercent) / 100n;
    const isCash = context.transactionType === 'DEPOSIT' || context.transactionType === 'WITHDRAWAL';
    const quiet = { ruleId: this.id, ruleName: this.name, triggered: false, scoreContribution: 0, severity: RiskLevel.LOW };
    if (!isCash || !context.initiatedBy || context.amountInPaise < threshold || context.amountInPaise > this.singleApprovalLimit) {
      return quiet;
    }
    const previous = await this.prisma.riskAssessment.count({
      where: {
        initiatedBy: context.initiatedBy,
        transactionType: { in: ['DEPOSIT', 'WITHDRAWAL'] },
        amountInPaise: { gte: threshold, lte: this.singleApprovalLimit },
        assessedAt: { gte: new Date(context.timestamp.getTime() - 24 * 3600_000) },
        direction: context.direction,
      },
    });
    if (previous < this.maxNearLimitOps) return quiet;
    return {
      ruleId: this.id,
      ruleName: this.name,
      triggered: true,
      scoreContribution: 45,
      severity: RiskLevel.HIGH,
      reason: `${previous + 1} cash operations just below the approval limit by the same initiator within 24h`,
    };
  }
}
