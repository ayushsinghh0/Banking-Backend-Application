import { FraudService } from '../src/services/fraud.service';
import { CashStructuringRule } from '../src/rules/cash-structuring.rule';
import { VelocityRule } from '../src/rules/velocity.rule';
import { RiskLevel, AlertStatus } from '../generated/client';
import { ConflictError, ForbiddenError } from '@banksphere/common';

describe('FraudService (Risk Engine, Anomaly Detection, and Alerts)', () => {
  let mockPrisma: any;
  let fraudService: FraudService;
  const ctx = (overrides: Partial<any> = {}) => ({
    transactionId: 'tx-1',
    accountId: 'acc-1',
    amountInPaise: 500000n,
    timestamp: new Date(),
    direction: 'OUTBOUND' as const,
    ...overrides,
  });

  beforeEach(() => {
    mockPrisma = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      riskAssessment: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountInPaise: null }, _count: { _all: 0 } }),
      },
      fraudAlert: {
        create: jest.fn(({ data }: any) => ({ id: 'alert-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(({ data }: any) => ({ id: 'alert-1', ...data })),
      },
      fraudAlertEvent: { create: jest.fn(), findMany: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };
    mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));
    mockPrisma.$queryRaw = jest.fn().mockResolvedValue([]);
    fraudService = new FraudService(mockPrisma);
  });

  it('LOW RISK: records the assessment without an alert', async () => {
    const result = await fraudService.evaluateTransaction(ctx(), 'evt-1');
    expect(result.riskLevel).toBe(RiskLevel.LOW);
    expect(mockPrisma.riskAssessment.create).toHaveBeenCalled();
    expect(mockPrisma.fraudAlert.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('HIGH RISK: alert and its fraud.alert.created.v1 outbox event are written in the same transaction', async () => {
    const result = await fraudService.evaluateTransaction(ctx({ amountInPaise: 25000000n }), 'evt-2');
    expect(result.riskLevel).toBe(RiskLevel.HIGH);
    expect(result.alertCreated).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.outboxEvent.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ eventType: 'fraud.alert.created.v1', aggregateId: 'alert-1' })
    );
  });

  it('INBOUND (mule) side is scored separately and deduplicated per account+direction', async () => {
    await fraudService.evaluateTransaction(ctx({ accountId: 'acc-2', direction: 'INBOUND' }), 'evt-3');
    expect(mockPrisma.processedEvent.create.mock.calls[0][0].data.eventId).toBe('evt-3:acc-2:INBOUND');
    expect(mockPrisma.riskAssessment.create.mock.calls[0][0].data.direction).toBe('INBOUND');
  });

  it('CONSUMER IDEMPOTENCY: an already processed event is skipped; a concurrent duplicate (P2002) too', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValueOnce({ id: 'pe-1' });
    expect((await fraudService.evaluateTransaction(ctx(), 'evt-dup')).alertCreated).toBe(false);
    expect(mockPrisma.riskAssessment.create).not.toHaveBeenCalled();

    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    expect((await fraudService.evaluateTransaction(ctx({ amountInPaise: 50000000n }), 'evt-race')).alertCreated).toBe(false);
  });

  it('DRY RUN: /evaluate preview never writes anything', async () => {
    const result = await fraudService.previewTransaction(ctx({ amountInPaise: 50000000n }));
    expect(result.riskLevel).toBe(RiskLevel.HIGH);
    expect(mockPrisma.riskAssessment.create).not.toHaveBeenCalled();
    expect(mockPrisma.fraudAlert.create).not.toHaveBeenCalled();
  });

  const analyst = (id: string) => ({ id, email: `${id}@bank.com`, role: 'FRAUD_ANALYST' as const, mfa: true });

  it('TRIAGE: status changes are attributed and kept in the append-only history', async () => {
    mockPrisma.fraudAlert.findUnique.mockResolvedValue({ id: 'alert-1', status: AlertStatus.OPEN, severity: RiskLevel.MEDIUM });
    const result = await fraudService.updateAlertStatus(analyst('analyst-1'), 'alert-1', AlertStatus.DISMISSED, 'false positive');
    expect(result.pendingSecondApproval).toBe(false);
    expect(mockPrisma.fraudAlert.update.mock.calls[0][0].data).toEqual({
      status: AlertStatus.DISMISSED,
      reviewedBy: 'analyst-1',
      closeRequestedBy: null,
      closeRequestedStatus: null,
    });
    expect(mockPrisma.fraudAlertEvent.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ actorId: 'analyst-1', fromStatus: AlertStatus.OPEN, toStatus: AlertStatus.DISMISSED, note: 'false positive' })
    );
  });

  it('TRIAGE: nobody may triage an alert about a transaction they initiated', async () => {
    mockPrisma.fraudAlert.findUnique.mockResolvedValue({ id: 'alert-1', status: AlertStatus.OPEN, severity: RiskLevel.LOW, initiatedBy: 'teller-1' });
    await expect(fraudService.updateAlertStatus(analyst('teller-1'), 'alert-1', AlertStatus.DISMISSED)).rejects.toThrow(ForbiddenError);
    expect(mockPrisma.fraudAlert.update).not.toHaveBeenCalled();
  });

  it('TRIAGE: closing a HIGH alert needs a second, different analyst', async () => {
    mockPrisma.fraudAlert.findUnique.mockResolvedValue({ id: 'alert-1', status: AlertStatus.OPEN, severity: RiskLevel.HIGH });
    const first = await fraudService.updateAlertStatus(analyst('analyst-1'), 'alert-1', AlertStatus.RESOLVED);
    expect(first.pendingSecondApproval).toBe(true);
    expect(mockPrisma.fraudAlert.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: AlertStatus.UNDER_REVIEW, closeRequestedBy: 'analyst-1', closeRequestedStatus: AlertStatus.RESOLVED })
    );

    // The proposer can't confirm their own proposal
    mockPrisma.fraudAlert.findUnique.mockResolvedValue({
      id: 'alert-1', status: AlertStatus.UNDER_REVIEW, severity: RiskLevel.HIGH, closeRequestedBy: 'analyst-1', closeRequestedStatus: AlertStatus.RESOLVED,
    });
    await expect(fraudService.updateAlertStatus(analyst('analyst-1'), 'alert-1', AlertStatus.RESOLVED)).rejects.toThrow(ConflictError);

    const second = await fraudService.updateAlertStatus(analyst('analyst-2'), 'alert-1', AlertStatus.RESOLVED);
    expect(second.pendingSecondApproval).toBe(false);
    expect(mockPrisma.fraudAlert.update.mock.calls.at(-1)[0].data).toEqual(
      expect.objectContaining({ status: AlertStatus.RESOLVED, reviewedBy: 'analyst-2', closeRequestedBy: null })
    );
  });

  it('STRUCTURING: repeated cash operations just under the approval limit by one teller are flagged', async () => {
    const rule = new CashStructuringRule(mockPrisma, 20_000_000n, 80n, 2);
    const cash = ctx({ amountInPaise: 19_000_000n, transactionType: 'DEPOSIT', initiatedBy: 'teller-1', direction: 'INBOUND' });
    mockPrisma.riskAssessment.count.mockResolvedValue(1);
    expect((await rule.evaluate(cash)).triggered).toBe(false);
    mockPrisma.riskAssessment.count.mockResolvedValue(2);
    expect((await rule.evaluate(cash)).triggered).toBe(true);
    // Small amounts, transfers and amounts above the limit (already dual-controlled) are not structuring
    expect((await rule.evaluate({ ...cash, amountInPaise: 1_000_000n })).triggered).toBe(false);
    expect((await rule.evaluate({ ...cash, transactionType: 'TRANSFER' })).triggered).toBe(false);
    expect((await rule.evaluate({ ...cash, amountInPaise: 30_000_000n })).triggered).toBe(false);
  });

  it('STRUCTURING: small cash operations into one account that add up past the approval limit are flagged', async () => {
    const rule = new CashStructuringRule(mockPrisma, 20_000_000n, 80n, 2);
    const cash = ctx({ amountInPaise: 5_000_000n, transactionType: 'DEPOSIT', initiatedBy: 'teller-1', direction: 'INBOUND' });
    mockPrisma.riskAssessment.aggregate.mockResolvedValue({ _sum: { amountInPaise: 14_000_000n }, _count: { _all: 3 } });
    expect((await rule.evaluate(cash)).triggered).toBe(false); // 19,000,000 total: still below the limit
    mockPrisma.riskAssessment.aggregate.mockResolvedValue({ _sum: { amountInPaise: 16_000_000n }, _count: { _all: 4 } });
    const flagged = await rule.evaluate(cash); // 21,000,000 total across 5 operations
    expect(flagged.triggered).toBe(true);
    expect(mockPrisma.riskAssessment.aggregate.mock.calls.at(-1)[0].where).toEqual(expect.objectContaining({ initiatedBy: 'teller-1', accountId: 'acc-1' }));
  });

  it('VELOCITY: the window is bounded by the evaluated event (a late replay does not count later transactions)', async () => {
    const rule = new VelocityRule(mockPrisma, 60, 3);
    const at = new Date('2026-10-27T10:00:00Z');
    await rule.evaluate(ctx({ timestamp: at }));
    expect(mockPrisma.riskAssessment.count).toHaveBeenCalledWith({
      where: { accountId: 'acc-1', assessedAt: { gte: new Date(at.getTime() - 60_000), lte: at } },
    });
  });

  it('VELOCITY ALERT FLOOD: no second alert while an open velocity alert exists for the account; the assessment is still recorded', async () => {
    mockPrisma.riskAssessment.count.mockResolvedValue(10); // ping-pong transfers: velocity fires every time
    mockPrisma.fraudAlert.findFirst.mockResolvedValue({ id: 'alert-0' });
    const result = await fraudService.evaluateTransaction(ctx({ amountInPaise: 1n }), 'evt-pp');
    expect(result.riskLevel).toBe(RiskLevel.HIGH);
    expect(result.alertCreated).toBe(false);
    expect(result.duplicateOfAlertId).toBe('alert-0');
    expect(mockPrisma.riskAssessment.create).toHaveBeenCalled();
    expect(mockPrisma.fraudAlert.create).not.toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled(); // so no URGENT email either
    const where = mockPrisma.fraudAlert.findFirst.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        accountId: 'acc-1',
        status: { in: [AlertStatus.OPEN, AlertStatus.UNDER_REVIEW] },
        ruleIds: { has: 'RULE_VELOCITY_CHECK' },
      })
    );
    expect(Date.now() - where.createdAt.gte.getTime()).toBeLessThanOrEqual(24 * 3600_000 + 1_000);
    // Serialised per account, so two concurrent evaluations can't both create the "first" alert
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  it('VELOCITY ALERT: the first one is created and tagged with its rule', async () => {
    mockPrisma.riskAssessment.count.mockResolvedValue(10);
    const result = await fraudService.evaluateTransaction(ctx({ amountInPaise: 1n }), 'evt-v1');
    expect(result.alertCreated).toBe(true);
    expect(mockPrisma.fraudAlert.create.mock.calls[0][0].data.ruleIds).toEqual(['RULE_VELOCITY_CHECK']);
  });

  it('VELOCITY ALERT: another rule firing as well is a new signal and still raises an alert', async () => {
    mockPrisma.riskAssessment.count.mockResolvedValue(10);
    mockPrisma.fraudAlert.findFirst.mockResolvedValue({ id: 'alert-0' });
    const result = await fraudService.evaluateTransaction(ctx({ amountInPaise: 25000000n }), 'evt-v2');
    expect(result.alertCreated).toBe(true);
    expect(mockPrisma.fraudAlert.create.mock.calls[0][0].data.ruleIds).toEqual(['RULE_AMOUNT_THRESHOLD', 'RULE_VELOCITY_CHECK']);
  });

  it('STRUCTURING: cash split across several tellers into one account is flagged (per-account 24h total)', async () => {
    const rule = new CashStructuringRule(mockPrisma, 20_000_000n, 80n, 2);
    const cash = ctx({ amountInPaise: 5_000_000n, transactionType: 'DEPOSIT', initiatedBy: 'teller-3', direction: 'INBOUND' });
    mockPrisma.riskAssessment.aggregate.mockImplementation(async ({ where }: any) =>
      where.initiatedBy
        ? { _sum: { amountInPaise: null }, _count: { _all: 0 } } // this teller has done nothing else
        : { _sum: { amountInPaise: 16_000_000n }, _count: { _all: 4 } } // four deposits by other tellers
    );
    const flagged = await rule.evaluate(cash);
    expect(flagged.triggered).toBe(true);
    expect(flagged.reason).toMatch(/one account/);
    const perAccount = mockPrisma.riskAssessment.aggregate.mock.calls.map((c: any[]) => c[0].where).find((w: any) => !w.initiatedBy);
    expect(perAccount).toEqual(expect.objectContaining({ accountId: 'acc-1', direction: 'INBOUND' }));
  });

  it('STRUCTURING: several near-limit cash operations on one account by different tellers are flagged', async () => {
    const rule = new CashStructuringRule(mockPrisma, 20_000_000n, 80n, 2);
    const cash = ctx({ amountInPaise: 19_000_000n, transactionType: 'DEPOSIT', initiatedBy: 'teller-3', direction: 'INBOUND' });
    mockPrisma.riskAssessment.count.mockImplementation(async ({ where }: any) => (where.initiatedBy ? 0 : 2));
    expect((await rule.evaluate(cash)).triggered).toBe(true);
  });

  it('STRUCTURING: the per-account rule also applies without a known initiator, and windows end at the evaluated event', async () => {
    const rule = new CashStructuringRule(mockPrisma, 20_000_000n, 80n, 2);
    const at = new Date('2026-10-27T10:00:00Z');
    mockPrisma.riskAssessment.aggregate.mockResolvedValue({ _sum: { amountInPaise: 16_000_000n }, _count: { _all: 2 } });
    const flagged = await rule.evaluate(ctx({ amountInPaise: 5_000_000n, transactionType: 'WITHDRAWAL', direction: 'OUTBOUND', timestamp: at }));
    expect(flagged.triggered).toBe(true);
    for (const [arg] of mockPrisma.riskAssessment.aggregate.mock.calls) {
      expect(arg.where.assessedAt).toEqual({ gte: new Date(at.getTime() - 24 * 3600_000), lte: at });
    }
  });

  it('maps risk scores to levels', () => {
    expect(FraudService.scoreToRiskLevel(0)).toBe(RiskLevel.LOW);
    expect(FraudService.scoreToRiskLevel(20)).toBe(RiskLevel.MEDIUM);
    expect(FraudService.scoreToRiskLevel(45)).toBe(RiskLevel.HIGH);
    expect(FraudService.scoreToRiskLevel(85)).toBe(RiskLevel.CRITICAL);
  });
});
