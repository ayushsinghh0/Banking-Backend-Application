import { FraudService } from '../src/services/fraud.service';
import { RiskLevel, AlertStatus } from '../generated/client';

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
      riskAssessment: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      fraudAlert: {
        create: jest.fn(({ data }: any) => ({ id: 'alert-1', ...data })),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(({ data }: any) => ({ id: 'alert-1', ...data })),
      },
      fraudAlertEvent: { create: jest.fn(), findMany: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };
    mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));
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

  it('TRIAGE: status changes are attributed and kept in the append-only history', async () => {
    mockPrisma.fraudAlert.findUnique.mockResolvedValue({ id: 'alert-1', status: AlertStatus.OPEN });
    await fraudService.updateAlertStatus({ id: 'analyst-1', email: 'a@b.com', role: 'SUPPORT', mfa: true }, 'alert-1', AlertStatus.DISMISSED, 'false positive');
    expect(mockPrisma.fraudAlert.update.mock.calls[0][0].data).toEqual({ status: AlertStatus.DISMISSED, reviewedBy: 'analyst-1' });
    expect(mockPrisma.fraudAlertEvent.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ actorId: 'analyst-1', fromStatus: AlertStatus.OPEN, toStatus: AlertStatus.DISMISSED, note: 'false positive' })
    );
  });

  it('maps risk scores to levels', () => {
    expect(FraudService.scoreToRiskLevel(0)).toBe(RiskLevel.LOW);
    expect(FraudService.scoreToRiskLevel(20)).toBe(RiskLevel.MEDIUM);
    expect(FraudService.scoreToRiskLevel(45)).toBe(RiskLevel.HIGH);
    expect(FraudService.scoreToRiskLevel(85)).toBe(RiskLevel.CRITICAL);
  });
});
