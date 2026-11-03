import { TransactionEvaluationContext, RiskRuleResult } from '../types';

export interface IRiskRule {
  readonly id: string;
  readonly name: string;
  evaluate(context: TransactionEvaluationContext): Promise<RiskRuleResult>;
}
