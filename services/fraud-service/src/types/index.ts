import { RiskLevel } from '../../generated/client';

export interface TransactionEvaluationContext {
  transactionId: string;
  accountId: string;
  amountInPaise: bigint;
  timestamp: Date;
  /** OUTBOUND: money leaving the account; INBOUND: money arriving (mule-account detection) */
  direction: 'OUTBOUND' | 'INBOUND';
  /** DEPOSIT | WITHDRAWAL | TRANSFER */
  transactionType?: string;
  /** Customer who sent a transfer, or the teller who handled cash */
  initiatedBy?: string;
  cashOperationId?: string;
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
