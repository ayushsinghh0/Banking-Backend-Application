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
    const quiet = { ruleId: this.id, ruleName: this.name, triggered: false, scoreContribution: 0, severity: RiskLevel.LOW };
    const isCash = context.transactionType === 'DEPOSIT' || context.transactionType === 'WITHDRAWAL';
    // Operations above the limit are already dual-controlled; structuring is about staying below it
    if (!isCash || !context.initiatedBy || context.amountInPaise > this.singleApprovalLimit) return quiet;

    const since = new Date(context.timestamp.getTime() - 24 * 3600_000);
    const threshold = (this.singleApprovalLimit * this.nearLimitRatioPercent) / 100n;
    const sameInitiator = {
      initiatedBy: context.initiatedBy,
      transactionType: { in: ['DEPOSIT', 'WITHDRAWAL'] },
      amountInPaise: { lte: this.singleApprovalLimit },
      assessedAt: { gte: since },
      direction: context.direction,
    };

    // 1. Several operations just under the limit by the same person
    if (context.amountInPaise >= threshold) {
      const nearLimit = await this.prisma.riskAssessment.count({ where: { ...sameInitiator, amountInPaise: { gte: threshold, lte: this.singleApprovalLimit } } });
      if (nearLimit >= this.maxNearLimitOps) {
        return this.flag(`${nearLimit + 1} cash operations just below the approval limit by the same initiator within 24h`);
      }
    }

    // 2. Split operations into one account that together exceed what a single approval would have caught
    const toAccount = await this.prisma.riskAssessment.aggregate({
      _sum: { amountInPaise: true },
      _count: { _all: true },
      where: { ...sameInitiator, accountId: context.accountId },
    });
    const total = (toAccount._sum.amountInPaise ?? 0n) + context.amountInPaise;
    if (toAccount._count._all >= 1 && total > this.singleApprovalLimit) {
      return this.flag(`${toAccount._count._all + 1} cash operations by the same initiator on one account total ${total.toString()} paise within 24h, above the single-approval limit`);
    }
    return quiet;
  }

  private flag(reason: string): RiskRuleResult {
    return { ruleId: this.id, ruleName: this.name, triggered: true, scoreContribution: 45, severity: RiskLevel.HIGH, reason };
  }
}
