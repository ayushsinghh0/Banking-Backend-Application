import { NotificationService } from '../src/services/notification.service';
import { NotificationStatus } from '../generated/client';
import { TransientError, isTransientError } from '@banksphere/common';

describe('NotificationService', () => {
  let mockPrisma: any;
  let mockEmailProvider: any;
  let mockDlqPublisher: any;
  let service: NotificationService;

  const txEvent = (overrides: Partial<any> = {}) => ({
    eventId: 'evt-1',
    eventType: 'transaction.completed.v1' as const,
    timestamp: new Date().toISOString(),
    transactionId: 'tx-1',
    referenceId: 'TXN-1',
    type: 'DEPOSIT' as const,
    amountInPaise: '100000',
    destinationAccountId: 'acc-1',
    destinationCustomerId: 'cust-1',
    ...overrides,
  });

  beforeEach(() => {
    mockPrisma = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      notificationLog: { create: jest.fn() },
      notificationDelivery: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      userContact: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'cust-1', email: 'alice@bank.com' }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accountOwner: { findUnique: jest.fn(), createMany: jest.fn() },
    };
    mockPrisma.$transaction = jest.fn((ops: any[]) => Promise.all(ops));
    mockEmailProvider = { sendEmail: jest.fn().mockResolvedValue({ messageId: 'm-1' }) };
    mockDlqPublisher = { publish: jest.fn() };
    service = new NotificationService(mockPrisma, mockEmailProvider, mockDlqPublisher, 3);
  });

  it('sends to the real account holder and records the delivery', async () => {
    expect(await service.handleTransactionCompleted(txEvent())).toBe(true);
    expect(mockEmailProvider.sendEmail.mock.calls[0][0].recipient).toBe('alice@bank.com');
    expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-1', recipient: 'alice@bank.com' } });
    expect(mockPrisma.processedEvent.create).toHaveBeenCalled();
  });

  it('IDEMPOTENCY: a duplicate event, or an already-delivered recipient, is not emailed again', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValueOnce({ id: 'pe' });
    expect(await service.handleTransactionCompleted(txEvent())).toBe(false);

    mockPrisma.notificationDelivery.findUnique.mockResolvedValueOnce({ id: 'd-1' });
    await service.dispatchWithRetryAndDLQ('evt-1', 'x', { recipient: 'alice@bank.com', subject: 's', body: 'b' });
    expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
  });

  it('ORDERING: if the contact is not known yet, the event is retried (transient), not dropped', async () => {
    mockPrisma.userContact.findUnique.mockResolvedValue(null);
    const err = await service.handleTransactionCompleted(txEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
  });

  it('SMTP OUTAGE: transient failures are retried later instead of being dead-lettered', async () => {
    mockEmailProvider.sendEmail.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const err = await service.dispatchWithRetryAndDLQ('evt-1', 'x', { recipient: 'a@b.com', subject: 's', body: 'b' }).catch((e) => e);
    expect(isTransientError(err)).toBe(true);
    expect(mockDlqPublisher.publish).not.toHaveBeenCalled();
  });

  it('PERMANENT failure (e.g. 550 rejected recipient) is logged DEAD_LETTER and sent to the DLQ', async () => {
    mockEmailProvider.sendEmail.mockRejectedValue(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
    await service.dispatchWithRetryAndDLQ('evt-9', 'x', { recipient: 'gone@b.com', subject: 's', body: 'b' });
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(3);
    expect(mockPrisma.notificationLog.create.mock.calls[0][0].data.status).toBe(NotificationStatus.DEAD_LETTER);
    expect(mockDlqPublisher.publish).toHaveBeenCalledWith('notifications.dlq', 'evt-9', expect.objectContaining({ originalEventId: 'evt-9' }));
  });

  it('CONTACT HIJACK: user.registered.v1 is insert-only and never overwrites an existing address', async () => {
    mockPrisma.userContact.createMany.mockResolvedValue({ count: 0 });
    await service.handleUserRegistered({ eventId: 'e', eventType: 'user.registered.v1', timestamp: '', userId: 'cust-1', email: 'attacker@evil.com', role: 'CUSTOMER' });
    expect(mockPrisma.userContact.createMany).toHaveBeenCalledWith({ data: [{ userId: 'cust-1', email: 'attacker@evil.com' }], skipDuplicates: true });
    expect(mockPrisma.userContact.update).toBeUndefined();
  });

  it('masks account numbers in welcome emails', async () => {
    await service.handleAccountCreated({ eventId: 'evt-a', eventType: 'account.created.v1', timestamp: new Date().toISOString(), accountId: 'acc-1', accountNumber: '100112345678', customerId: 'cust-1', accountType: 'SAVINGS', currency: 'INR' });
    const email = mockEmailProvider.sendEmail.mock.calls[0][0];
    expect(email.body).toContain('XXXXXXXX5678');
    expect(email.body).not.toContain('100112345678');
  });
});
