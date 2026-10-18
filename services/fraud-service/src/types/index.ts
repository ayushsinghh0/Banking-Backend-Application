import { RiskLevel } from '../../generated/client';

export interface TransactionEvaluationContext {
  transactionId: string;
  accountId: string;
  amountInPaise: bigint;
  timestamp: Date;
}

export interface RiskRuleResult {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  scoreContribution: number;
  severity: RiskLevel;
  reason?: string;
}

export interface RiskEvaluationSummary {
  transactionId: string;
  accountId: string;
  riskScore: number; // 0 to 100
  riskLevel: RiskLevel;
  triggeredRules: RiskRuleResult[];
  alertCreated: boolean;
  alertId?: string;
}
