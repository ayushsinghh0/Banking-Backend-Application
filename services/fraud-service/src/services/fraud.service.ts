import crypto from 'crypto';
import { AuthenticatedUser, NotFoundError, logger } from '@banksphere/common';
import { PrismaClient, RiskLevel, AlertStatus, FraudAlert, Prisma } from '../../generated/client';
import { IRiskRule } from '../rules/risk-rule.interface';
import { AmountThresholdRule } from '../rules/amount-threshold.rule';
import { VelocityRule } from '../rules/velocity.rule';
import {
  TransactionEvaluationContext,
  RiskRuleResult,
  RiskEvaluationSummary,
} from '../types';

export class FraudService {
  private readonly rules: IRiskRule[];

  constructor(
    private readonly prisma: PrismaClient,
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

  public static scoreToRiskLevel(riskScore: number): RiskLevel {
    if (riskScore >= 80) return RiskLevel.CRITICAL;
    if (riskScore >= 40) return RiskLevel.HIGH;
    if (riskScore >= 20) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /** Dedupe key: one assessment per (event, account, direction) */
  private static processedKey(eventId: string, context: TransactionEvaluationContext): string {
    return `${eventId}:${context.accountId}:${context.direction}`;
  }

  public async isEventProcessed(key: string): Promise<boolean> {
    return Boolean(await this.prisma.processedEvent.findUnique({ where: { eventId: key } }));
  }

  private async score(context: TransactionEvaluationContext) {
    const triggeredRules: RiskRuleResult[] = [];
    let totalScore = 0;
    for (const rule of this.rules) {
      const result = await rule.evaluate(context);
      if (result.triggered) {
        triggeredRules.push(result);
        totalScore += result.scoreContribution;
      }
    }
    const riskScore = Math.min(100, totalScore);
    return { triggeredRules, riskScore, riskLevel: FraudService.scoreToRiskLevel(riskScore) };
  }

  /**
   * Scores a transaction without recording anything (staff "what if" tool). It cannot create
   * assessments, so it can't be used to skew velocity counts or inject alerts.
   */
  public async previewTransaction(context: TransactionEvaluationContext): Promise<RiskEvaluationSummary> {
    const { triggeredRules, riskScore, riskLevel } = await this.score(context);
    return {
      transactionId: context.transactionId,
      accountId: context.accountId,
      riskScore,
      riskLevel,
      triggeredRules,
      alertCreated: false,
    };
  }

  /**
   * Evaluates one side of a completed transaction from Kafka. The processed-event marker, the
   * assessment, the alert and its fraud.alert.created.v1 outbox event are written in ONE transaction,
   * and the marker is unique, so a redelivered or concurrently consumed message can never produce a
   * second assessment or alert, and an alert's notification can never be lost.
   */
  public async evaluateTransaction(context: TransactionEvaluationContext, eventId: string): Promise<RiskEvaluationSummary> {
    const key = FraudService.processedKey(eventId, context);
    const duplicate: RiskEvaluationSummary = {
      transactionId: context.transactionId,
      accountId: context.accountId,
      riskScore: 0,
      riskLevel: RiskLevel.LOW,
      triggeredRules: [],
      alertCreated: false,
    };

    if (await this.isEventProcessed(key)) {
      logger.info({ eventId, accountId: context.accountId }, 'Duplicate fraud evaluation event skipped');
      return duplicate;
    }

    const { triggeredRules, riskScore, riskLevel } = await this.score(context);
    const shouldAlert = riskLevel === RiskLevel.HIGH || riskLevel === RiskLevel.CRITICAL;

    let alert: FraudAlert | null = null;
    try {
      alert = await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({ data: { eventId: key, eventType: 'transaction.completed.v1' } });

        await tx.riskAssessment.create({
          data: {
            transactionId: context.transactionId,
            accountId: context.accountId,
            amountInPaise: context.amountInPaise,
            riskScore,
            riskLevel,
            direction: context.direction,
            triggeredRules: triggeredRules as unknown as Prisma.InputJsonValue,
            assessedAt: context.timestamp,
          },
        });

        if (!shouldAlert) return null;
        const reasons = triggeredRules.map((r) => r.reason).join(' | ');
        const created = await tx.fraudAlert.create({
          data: {
            transactionId: context.transactionId,
            accountId: context.accountId,
            severity: riskLevel,
            reason: `[${context.direction}] ${reasons || 'Multiple risk anomalies detected'}`,
            status: AlertStatus.OPEN,
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FRAUD_ALERT',
            aggregateId: created.id,
            eventType: 'fraud.alert.created.v1',
            payload: {
              eventId: crypto.randomUUID(),
              eventType: 'fraud.alert.created.v1',
              timestamp: new Date().toISOString(),
              alertId: created.id,
              transactionId: created.transactionId,
              accountId: created.accountId,
              severity: created.severity,
              reason: created.reason,
            },
          },
        });
        return created;
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        logger.info({ eventId }, 'Concurrent duplicate fraud evaluation event skipped');
        return duplicate;
      }
      throw err;
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

  /**
   * Analyst triage of an alert; every change is attributed and kept in fraud_alert_events
   */
  public async updateAlertStatus(actor: AuthenticatedUser, alertId: string, status: AlertStatus, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.fraudAlert.findUnique({ where: { id: alertId } });
      if (!existing) {
        throw new NotFoundError('Fraud alert not found');
      }
      const updated = await tx.fraudAlert.update({
        where: { id: alertId },
        data: { status, reviewedBy: actor.id },
      });
      await tx.fraudAlertEvent.create({
        data: { alertId, actorId: actor.id, fromStatus: existing.status, toStatus: status, note },
      });
      return updated;
    });
  }

  public async getAlertHistory(alertId: string) {
    return this.prisma.fraudAlertEvent.findMany({ where: { alertId }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Retrieves fraud alerts for compliance officers
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
