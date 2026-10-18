import crypto from 'crypto';
import { AuthenticatedUser, ConflictError, ForbiddenError, NotFoundError, logger } from '@banksphere/common';
import { PrismaClient, RiskLevel, AlertStatus, FraudAlert, Prisma } from '../../generated/client';
import { IRiskRule } from '../rules/risk-rule.interface';
import { AmountThresholdRule } from '../rules/amount-threshold.rule';
import { VelocityRule } from '../rules/velocity.rule';
import { CashStructuringRule } from '../rules/cash-structuring.rule';
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
      new CashStructuringRule(this.prisma),
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
            transactionType: context.transactionType,
            initiatedBy: context.initiatedBy,
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
            initiatedBy: context.initiatedBy,
            cashOperationId: context.cashOperationId,
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
   * Analyst triage of an alert, with separation of duties:
   * - nobody may triage an alert about a transaction they initiated (e.g. a teller's own cash operation);
   * - closing (RESOLVED/DISMISSED) a HIGH or CRITICAL alert needs two different analysts: the first call
   *   records a proposal, the second (by someone else, same target status) closes it.
   * Every step is attributed in fraud_alert_events.
   */
  public async updateAlertStatus(actor: AuthenticatedUser, alertId: string, status: AlertStatus, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fraud_alerts WHERE id = ${alertId} FOR UPDATE`;
      const existing = await tx.fraudAlert.findUnique({ where: { id: alertId } });
      if (!existing) {
        throw new NotFoundError('Fraud alert not found');
      }
      if (existing.initiatedBy && existing.initiatedBy === actor.id) {
        throw new ForbiddenError('You cannot triage an alert about a transaction you initiated');
      }
      const closing = status === AlertStatus.RESOLVED || status === AlertStatus.DISMISSED;
      const severe = existing.severity === RiskLevel.HIGH || existing.severity === RiskLevel.CRITICAL;

      if (closing && severe) {
        const confirmsProposal =
          existing.closeRequestedBy && existing.closeRequestedBy !== actor.id && existing.closeRequestedStatus === status;
        if (!confirmsProposal) {
          if (existing.closeRequestedBy === actor.id) {
            throw new ConflictError('Closing this alert needs confirmation by a different analyst');
          }
          const proposed = await tx.fraudAlert.update({
            where: { id: alertId },
            data: { status: AlertStatus.UNDER_REVIEW, closeRequestedBy: actor.id, closeRequestedStatus: status, reviewedBy: actor.id },
          });
          await tx.fraudAlertEvent.create({
            data: { alertId, actorId: actor.id, fromStatus: existing.status, toStatus: AlertStatus.UNDER_REVIEW, note: `Proposed ${status}${note ? `: ${note}` : ''}` },
          });
          return { ...proposed, pendingSecondApproval: true };
        }
      }

      const updated = await tx.fraudAlert.update({
        where: { id: alertId },
        data: { status, reviewedBy: actor.id, closeRequestedBy: null, closeRequestedStatus: null },
      });
      await tx.fraudAlertEvent.create({
        data: { alertId, actorId: actor.id, fromStatus: existing.status, toStatus: status, note },
      });
      return { ...updated, pendingSecondApproval: false };
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
