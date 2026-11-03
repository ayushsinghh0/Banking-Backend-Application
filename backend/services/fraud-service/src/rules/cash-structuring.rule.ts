import { IRiskRule } from './risk-rule.interface';
import { TransactionEvaluationContext, RiskRuleResult } from '../types';
import { PrismaClient, RiskLevel } from '../../generated/client';

/**
 * Flags "structuring": cash repeatedly moved just under the single-approval limit to avoid the maker-checker
 * control. Within a rolling 24 hours ending at the evaluated operation, it triggers on:
 * - several near-limit cash operations (>= `nearLimitRatio` of the limit) by the same initiator (teller), or on
 *   the same account by anyone;
 * - split cash operations on one account (in the same direction) that together exceed the limit, by the same
 *   initiator or across initiators (splitting deposits over several tellers is still caught).
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
    if (!isCash || context.amountInPaise > this.singleApprovalLimit) return quiet;

    const since = new Date(context.timestamp.getTime() - 24 * 3600_000);
    const threshold = (this.singleApprovalLimit * this.nearLimitRatioPercent) / 100n;
    // Bounded by the evaluated operation, so a late (retried/replayed) evaluation doesn't count later ones
    const cashBelowLimit = {
      transactionType: { in: ['DEPOSIT', 'WITHDRAWAL'] },
      amountInPaise: { lte: this.singleApprovalLimit },
      assessedAt: { gte: since, lte: context.timestamp },
      direction: context.direction,
    };
    const nearLimitOnly = { gte: threshold, lte: this.singleApprovalLimit };
    const isNearLimit = context.amountInPaise >= threshold;

    if (context.initiatedBy) {
      const sameInitiator = { ...cashBelowLimit, initiatedBy: context.initiatedBy };

      // 1. Several operations just under the limit by the same person
      if (isNearLimit) {
        const nearLimit = await this.prisma.riskAssessment.count({ where: { ...sameInitiator, amountInPaise: nearLimitOnly } });
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
    }

    // 3 + 4. The same per ACCOUNT, whoever initiated them: splitting the cash across several tellers (or
    // branches) must not hide it. Served by risk_assessments(account_id, assessed_at).
    const sameAccount = { ...cashBelowLimit, accountId: context.accountId };
    if (isNearLimit) {
      const nearLimit = await this.prisma.riskAssessment.count({ where: { ...sameAccount, amountInPaise: nearLimitOnly } });
      if (nearLimit >= this.maxNearLimitOps) {
        return this.flag(`${nearLimit + 1} cash operations just below the approval limit on one account within 24h`);
      }
    }
    const onAccount = await this.prisma.riskAssessment.aggregate({
      _sum: { amountInPaise: true },
      _count: { _all: true },
      where: sameAccount,
    });
    const accountTotal = (onAccount._sum.amountInPaise ?? 0n) + context.amountInPaise;
    if (onAccount._count._all >= 1 && accountTotal > this.singleApprovalLimit) {
      return this.flag(`${onAccount._count._all + 1} cash operations on one account total ${accountTotal.toString()} paise within 24h, above the single-approval limit`);
    }
    return quiet;
  }

  private flag(reason: string): RiskRuleResult {
    return { ruleId: this.id, ruleName: this.name, triggered: true, scoreContribution: 45, severity: RiskLevel.HIGH, reason };
  }
}
