import crypto from 'crypto';
import { NotFoundError, logger } from '@banksphere/common';
import { PrismaClient, RiskLevel, AlertStatus, FraudAlert } from '../../generated/client';
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
      new AmountThresholdRule(BigInt(process.env.HIGH_AMOUNT_THRESHOLD_PAISE || '20000000')),
      new VelocityRule(
        this.prisma,
        Number(process.env.VELOCITY_WINDOW_SECONDS || 60),
        Number(process.env.VELOCITY_MAX_TRANSACTIONS || 3)
      ),
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
   * Evaluates transaction risk across all configured rules.
   * The processed-event marker, assessment and alert are written in one DB transaction, and the
   * marker insert is unique on eventId, so a redelivered or concurrently consumed Kafka message
   * can never produce a second assessment or alert.
   */
  public async evaluateTransaction(
    context: TransactionEvaluationContext,
    eventId?: string
  ): Promise<RiskEvaluationSummary> {
    const duplicate: RiskEvaluationSummary = {
      transactionId: context.transactionId,
      accountId: context.accountId,
      riskScore: 0,
      riskLevel: RiskLevel.LOW,
      triggeredRules: [],
      alertCreated: false,
    };

    // 1. Consumer Idempotency fast-path
    if (eventId && (await this.isEventProcessed(eventId))) {
      logger.info({ eventId }, 'Duplicate fraud evaluation event skipped');
      return duplicate;
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
    const riskLevel = FraudService.scoreToRiskLevel(riskScore);
    const shouldAlert = riskLevel === RiskLevel.HIGH || riskLevel === RiskLevel.CRITICAL;

    let alert: FraudAlert | null = null;
    try {
      alert = await this.prisma.$transaction(async (tx) => {
        if (eventId) {
          await tx.processedEvent.create({
            data: { eventId, eventType: 'transaction.completed.v1' },
          });
        }

        // 3. Record Risk Assessment
        await tx.riskAssessment.create({
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

        // 4. Raise FraudAlert for High or Critical risk
        if (!shouldAlert) return null;
        const reasons = triggeredRules.map((r) => r.reason).join(' | ');
        return tx.fraudAlert.create({
          data: {
            transactionId: context.transactionId,
            accountId: context.accountId,
            severity: riskLevel,
            reason: reasons || 'Multiple risk anomalies detected',
            status: AlertStatus.OPEN,
          },
        });
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        logger.info({ eventId }, 'Concurrent duplicate fraud evaluation event skipped');
        return duplicate;
      }
      throw err;
    }

    // 5. Publish fraud.alert.created.v1 for Notification & Audit (after commit)
    if (alert && this.alertPublisher) {
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
        logger.error({ err, alertId: alert.id }, 'Failed to emit fraud.alert.created.v1 to Kafka');
      }
    }

    return {
      transactionId: context.transactionId,
      accountId: context.accountId,
      riskScore,
      riskLevel,
      triggeredRules,
      alertCreated: Boolean(alert),
      alertId: alert?.id,
    };
  }

  public static scoreToRiskLevel(riskScore: number): RiskLevel {
    if (riskScore >= 80) return RiskLevel.CRITICAL;
    if (riskScore >= 40) return RiskLevel.HIGH;
    if (riskScore >= 20) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /**
   * Analyst triage of an alert
   */
  public async updateAlertStatus(alertId: string, status: AlertStatus) {
    const existing = await this.prisma.fraudAlert.findUnique({ where: { id: alertId } });
    if (!existing) {
      throw new NotFoundError('Fraud alert not found');
    }
    return this.prisma.fraudAlert.update({ where: { id: alertId }, data: { status } });
  }

  /**
   * Retrieves active open fraud alerts for compliance officers
   */
  public async getAlerts(status?: AlertStatus, limit = 20, offset = 0) {
    return this.prisma.fraudAlert.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
