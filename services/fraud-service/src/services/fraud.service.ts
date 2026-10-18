import crypto from 'crypto';
import { PrismaClient, RiskLevel, AlertStatus } from '../generated/client';
import { IRiskRule } from '../rules/risk-rule.interface';
import { AmountThresholdRule } from '../rules/amount-threshold.rule';
import { VelocityRule } from '../rules/velocity.rule';
import {
  TransactionEvaluationContext,
  RiskRuleResult,
  RiskEvaluationSummary,
} from '../types';

export interface KafkaAlertPublisher {
  publish(topic: string, key: string, payload: any): Promise<void>;
}

export class FraudService {
  private readonly rules: IRiskRule[];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly alertPublisher?: KafkaAlertPublisher,
    rules?: IRiskRule[]
  ) {
    this.rules = rules || [
      new AmountThresholdRule(),
      new VelocityRule(this.prisma),
    ];
  }

  /**
   * Evaluates if a Kafka event was already processed to guarantee consumer idempotency
   */
  public async isEventProcessed(eventId: string): Promise<boolean> {
    const existing = await this.prisma.processedEvent.findUnique({
      where: { eventId },
    });
    return !!existing;
  }

  /**
   * Evaluates transaction risk across all configured rules
   */
  public async evaluateTransaction(
    context: TransactionEvaluationContext,
    eventId?: string
  ): Promise<RiskEvaluationSummary> {
    // 1. Consumer Idempotency Check
    if (eventId && (await this.isEventProcessed(eventId))) {
      console.log(`[FraudService] Duplicate event '${eventId}' skipped.`);
      return {
        transactionId: context.transactionId,
        accountId: context.accountId,
        riskScore: 0,
        riskLevel: RiskLevel.LOW,
        triggeredRules: [],
        alertCreated: false,
      };
    }

    const triggeredRules: RiskRuleResult[] = [];
    let totalScore = 0;

    // 2. Evaluate each rule in sequence
    for (const rule of this.rules) {
      const result = await rule.evaluate(context);
      if (result.triggered) {
        triggeredRules.push(result);
        totalScore += result.scoreContribution;
      }
    }

    const riskScore = Math.min(100, totalScore);

    // 3. Map score to RiskLevel
    let riskLevel = RiskLevel.LOW;
    if (riskScore >= 80) {
      riskLevel = RiskLevel.CRITICAL;
    } else if (riskScore >= 40) {
      riskLevel = RiskLevel.HIGH;
    } else if (riskScore >= 20) {
      riskLevel = RiskLevel.MEDIUM;
    }

    // 4. Record Risk Assessment in database
    await this.prisma.riskAssessment.create({
      data: {
        transactionId: context.transactionId,
        accountId: context.accountId,
        amountInPaise: context.amountInPaise,
        riskScore,
        riskLevel,
        triggeredRules: triggeredRules as any,
        assessedAt: context.timestamp,
      },
    });

    let alertCreated = false;
    let alertId: string | undefined;

    // 5. If High or Critical risk: raise FraudAlert and publish event
    if (riskLevel === RiskLevel.HIGH || riskLevel === RiskLevel.CRITICAL) {
      const reasons = triggeredRules.map((r) => r.reason).join(' | ');
      const alert = await this.prisma.fraudAlert.create({
        data: {
          transactionId: context.transactionId,
          accountId: context.accountId,
          severity: riskLevel,
          reason: reasons || 'Multiple risk anomalies detected',
          status: AlertStatus.OPEN,
        },
      });

      alertCreated = true;
      alertId = alert.id;

      // Publish fraud.alert.created.v1 to Kafka for Notification & Audit
      if (this.alertPublisher) {
        const alertEvent = {
          eventId: crypto.randomUUID(),
          eventType: 'fraud.alert.created.v1',
          timestamp: new Date().toISOString(),
          alertId: alert.id,
          transactionId: alert.transactionId,
          accountId: alert.accountId,
          severity: alert.severity,
          reason: alert.reason,
        };

        try {
          await this.alertPublisher.publish('fraud.alert.created.v1', alert.accountId, alertEvent);
        } catch (err) {
          console.error('[FraudService] Failed to emit fraud.alert.created.v1 to Kafka', err);
        }
      }
    }

    // 6. Record processed_events to prevent duplicate processing
    if (eventId) {
      await this.prisma.processedEvent.create({
        data: { eventId, eventType: 'transaction.completed.v1' },
      });
    }

    return {
      transactionId: context.transactionId,
      accountId: context.accountId,
      riskScore,
      riskLevel,
      triggeredRules,
      alertCreated,
      alertId,
    };
  }

  /**
   * Retrieves active open fraud alerts for compliance officers
   */
  public async getAlerts(status?: AlertStatus, limit = 20) {
    return this.prisma.fraudAlert.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
