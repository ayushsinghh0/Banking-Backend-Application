import { NotificationService } from '../src/services/notification.service';
import { NotificationStatus } from '../generated/client';
import { TransactionCompletedEvent } from '../src/types';

describe('NotificationService (Consumer Idempotency, Retries, and DLQ)', () => {
  let mockPrisma: any;
  let mockEmailProvider: any;
  let mockDlqPublisher: any;
  let notificationService: NotificationService;

  beforeEach(() => {
    mockPrisma = {
      processedEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      notificationLog: {
        create: jest.fn(),
      },
      userContact: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'cust-1', email: 'alice@bank.com' }),
        upsert: jest.fn(),
      },
      accountOwner: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };

    mockEmailProvider = {
      sendEmail: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
    };

    mockDlqPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    notificationService = new NotificationService(
      mockPrisma,
      mockEmailProvider,
      mockDlqPublisher,
      3
    );
  });

  describe('Consumer Idempotency', () => {
    it('should ignore duplicate Kafka event if eventId already exists in processed_events', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue({
        id: 'pe-1',
        eventId: 'evt-duplicate-123',
        eventType: 'transaction.completed.v1',
      });

      const event: TransactionCompletedEvent = {
        eventId: 'evt-duplicate-123',
        eventType: 'transaction.completed.v1',
        timestamp: new Date().toISOString(),
        transactionId: 'tx-1',
        referenceId: 'TXN-001',
        type: 'TRANSFER',
        amountInPaise: '50000',
      };

      const wasProcessed = await notificationService.handleTransactionCompleted(event);

      expect(wasProcessed).toBe(false);
      // Email should NEVER be dispatched on duplicate event!
      expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
      expect(mockPrisma.notificationLog.create).not.toHaveBeenCalled();
    });

    it('should process new Kafka event, dispatch email, and record in processed_events', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue(null); // Fresh event

      const event: TransactionCompletedEvent = {
        eventId: 'evt-fresh-999',
        eventType: 'transaction.completed.v1',
        timestamp: new Date().toISOString(),
        transactionId: 'tx-999',
        referenceId: 'TXN-999',
        type: 'DEPOSIT',
        amountInPaise: '100000', // ₹1,000.00
        destinationAccountId: 'acc-1',
        destinationCustomerId: 'cust-1',
      };

      const wasProcessed = await notificationService.handleTransactionCompleted(event);

      expect(wasProcessed).toBe(true);
      expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);
      // Sent to the real account holder, not a hardcoded mailbox
      expect(mockEmailProvider.sendEmail.mock.calls[0][0].recipient).toBe('alice@bank.com');
      expect(mockPrisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: NotificationStatus.SENT,
          }),
        })
      );
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({
        data: { eventId: 'evt-fresh-999', eventType: 'transaction.completed.v1' },
      });
    });
  });

  describe('Bounded Retries and Dead-Letter Queue (DLQ)', () => {
    it('should retry transient email failures and succeed on subsequent attempt', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue(null);

      // Fail first attempt, succeed second attempt
      mockEmailProvider.sendEmail
        .mockRejectedValueOnce(new Error('Temporary network glitch'))
        .mockResolvedValueOnce({ messageId: 'msg-recovered' });

      await notificationService.dispatchWithRetryAndDLQ(
        'evt-retry-1',
        'transaction.completed.v1',
        {
          recipient: 'user@test.com',
          subject: 'Test Retry',
          body: 'Hello',
        }
      );

      expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(2);
      expect(mockPrisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: NotificationStatus.SENT,
            retryCount: 1,
          }),
        })
      );
      // DLQ should NOT be called since it succeeded
      expect(mockDlqPublisher.publish).not.toHaveBeenCalled();
    });

    it('should exhaust max retries, mark as DEAD_LETTER, and route to DLQ topic', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue(null);

      // Consistently fail all attempts
      mockEmailProvider.sendEmail.mockRejectedValue(new Error('Fatal SMTP outage'));

      await notificationService.dispatchWithRetryAndDLQ(
        'evt-deadletter-1',
        'transaction.completed.v1',
        {
          recipient: 'user@test.com',
          subject: 'Test DLQ',
          body: 'Hello',
        }
      );

      // 3 attempts made
      expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(3);

      // Stored as DEAD_LETTER in database audit log
      expect(mockPrisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: NotificationStatus.DEAD_LETTER,
            retryCount: 3,
            lastError: 'Fatal SMTP outage',
          }),
        })
      );

      // Published to Dead-Letter Queue (DLQ) topic
      expect(mockDlqPublisher.publish).toHaveBeenCalledWith(
        'notifications.dlq',
        'evt-deadletter-1',
        expect.objectContaining({
          originalEventId: 'evt-deadletter-1',
          failureReason: 'Fatal SMTP outage',
        })
      );
    });
  });

  describe('Contact directory', () => {
    it('stores the email from user.registered.v1 and masks account numbers in welcome emails', async () => {
      await notificationService.handleUserRegistered({
        eventId: 'evt-u1',
        eventType: 'user.registered.v1',
        timestamp: new Date().toISOString(),
        userId: 'cust-1',
        email: 'alice@bank.com',
        role: 'CUSTOMER',
      });
      expect(mockPrisma.userContact.upsert).toHaveBeenCalled();

      mockPrisma.processedEvent.findUnique.mockResolvedValue(null);
      await notificationService.handleAccountCreated({
        eventId: 'evt-a1',
        eventType: 'account.created.v1',
        timestamp: new Date().toISOString(),
        accountId: 'acc-1',
        accountNumber: '100112345678',
        customerId: 'cust-1',
        accountType: 'SAVINGS',
        currency: 'INR',
      });

      const email = mockEmailProvider.sendEmail.mock.calls[0][0];
      expect(email.recipient).toBe('alice@bank.com');
      expect(email.body).toContain('XXXXXXXX5678');
      expect(email.body).not.toContain('100112345678');
    });
  });
});
