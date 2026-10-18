import { FraudService } from '../src/services/fraud.service';
import { RiskLevel, AlertStatus } from '../generated/client';

describe('FraudService (Risk Engine, Anomaly Detection, and Alerts)', () => {
  let mockPrisma: any;
  let mockAlertPublisher: any;
  let fraudService: FraudService;

  beforeEach(() => {
    mockPrisma = {
      processedEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      riskAssessment: {
        create: jest.fn(),
        count: jest.fn(),
      },
      fraudAlert: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((cb: any) => cb(mockPrisma)),
    };

    mockAlertPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    fraudService = new FraudService(mockPrisma, mockAlertPublisher);
  });

  describe('evaluateTransaction', () => {
    it('LOW RISK: normal transaction amount below threshold does not raise fraud alert', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue(null);
      mockPrisma.riskAssessment.count.mockResolvedValue(0); // Normal velocity

      const result = await fraudService.evaluateTransaction(
        {
          transactionId: 'tx-low-1',
          accountId: 'acc-1',
          amountInPaise: 500000n, // ₹5,000.00
          timestamp: new Date(),
        },
        'evt-low-1'
      );

      expect(result.riskScore).toBe(0);
      expect(result.riskLevel).toBe(RiskLevel.LOW);
      expect(result.alertCreated).toBe(false);

      // Verify assessment was persisted
      expect(mockPrisma.riskAssessment.create).toHaveBeenCalled();
      // No alert should be created
      expect(mockPrisma.fraudAlert.create).not.toHaveBeenCalled();
      expect(mockAlertPublisher.publish).not.toHaveBeenCalled();
    });

    it('HIGH RISK: transaction exceeding ₹2,00,000 raises FraudAlert and emits Kafka alert', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue(null);
      mockPrisma.riskAssessment.count.mockResolvedValue(0);
      mockPrisma.fraudAlert.create.mockResolvedValue({
        id: 'alert-high-1',
        transactionId: 'tx-high-1',
        accountId: 'acc-1',
        severity: RiskLevel.HIGH,
        reason: 'Transaction amount exceeds threshold',
        status: AlertStatus.OPEN,
      });

      const result = await fraudService.evaluateTransaction(
        {
          transactionId: 'tx-high-1',
          accountId: 'acc-1',
          amountInPaise: 25000000n, // ₹2,50,000.00 (Exceeds ₹2L)
          timestamp: new Date(),
        },
        'evt-high-1'
      );

      expect(result.riskScore).toBeGreaterThanOrEqual(40);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
      expect(result.alertCreated).toBe(true);

      // Verify FraudAlert was created in DB
      expect(mockPrisma.fraudAlert.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            severity: RiskLevel.HIGH,
            status: AlertStatus.OPEN,
          }),
        })
      );

      // Verify Kafka event published
      expect(mockAlertPublisher.publish).toHaveBeenCalledWith(
        'fraud.alert.created.v1',
        'acc-1',
        expect.objectContaining({
          eventType: 'fraud.alert.created.v1',
          severity: RiskLevel.HIGH,
        })
      );
    });

    it('CONSUMER IDEMPOTENCY: skips evaluation if Kafka eventId was already processed', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue({
        id: 'pe-1',
        eventId: 'evt-dup-1',
        eventType: 'transaction.completed.v1',
      });

      const result = await fraudService.evaluateTransaction(
        {
          transactionId: 'tx-dup-1',
          accountId: 'acc-1',
          amountInPaise: 50000000n,
          timestamp: new Date(),
        },
        'evt-dup-1'
      );

      expect(result.alertCreated).toBe(false);
      // Risk assessment should NOT be recorded again
      expect(mockPrisma.riskAssessment.create).not.toHaveBeenCalled();
    });
  });

  it('CONCURRENT DUPLICATE: a unique violation on processed_events is treated as already processed', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.riskAssessment.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const result = await fraudService.evaluateTransaction(
      { transactionId: 'tx-1', accountId: 'acc-1', amountInPaise: 50000000n, timestamp: new Date() },
      'evt-race-1'
    );

    expect(result.alertCreated).toBe(false);
    expect(mockAlertPublisher.publish).not.toHaveBeenCalled();
  });

  it('maps risk scores to levels', () => {
    expect(FraudService.scoreToRiskLevel(0)).toBe(RiskLevel.LOW);
    expect(FraudService.scoreToRiskLevel(20)).toBe(RiskLevel.MEDIUM);
    expect(FraudService.scoreToRiskLevel(45)).toBe(RiskLevel.HIGH);
    expect(FraudService.scoreToRiskLevel(85)).toBe(RiskLevel.CRITICAL);
  });
});
