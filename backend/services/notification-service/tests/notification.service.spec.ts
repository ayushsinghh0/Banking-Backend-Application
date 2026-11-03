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
  const smtpError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
  const unique = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  beforeEach(() => {
    mockPrisma = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      notificationLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
      notificationDelivery: { create: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userContact: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'cust-1', email: 'alice@bank.com' }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accountOwner: { findUnique: jest.fn(), createMany: jest.fn() },
    };
    mockPrisma.$transaction = jest.fn((ops: any[]) => Promise.all(ops));
    mockEmailProvider = { sendEmail: jest.fn().mockResolvedValue({ messageId: 'm-1' }) };
    mockDlqPublisher = { publish: jest.fn() };
    service = new NotificationService(mockPrisma, mockEmailProvider, mockDlqPublisher, { smtpCircuitOpenMs: 30_000 });
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends to the real account holder, claiming the delivery BEFORE sending', async () => {
    expect(await service.handleTransactionCompleted(txEvent())).toBe(true);
    expect(mockEmailProvider.sendEmail.mock.calls[0][0].recipient).toBe('alice@bank.com');
    expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-1:credit', recipient: 'alice@bank.com' } });
    expect(mockPrisma.notificationDelivery.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockEmailProvider.sendEmail.mock.invocationCallOrder[0]
    );
    expect(mockPrisma.notificationLog.create.mock.calls[0][0].data.status).toBe(NotificationStatus.SENT);
    expect(mockPrisma.processedEvent.create).toHaveBeenCalled();
  });

  it('IDEMPOTENCY: a duplicate event, or an already-claimed delivery, is not emailed again', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValueOnce({ id: 'pe' });
    expect(await service.handleTransactionCompleted(txEvent())).toBe(false);

    mockPrisma.notificationDelivery.create.mockRejectedValueOnce(unique());
    expect(await service.dispatchEmail('evt-1', 'x', { recipient: 'alice@bank.com', subject: 's', body: 'b' })).toBe('ALREADY_SENT');
    expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
  });

  it('OWN-ACCOUNT TRANSFER: the same customer gets both the debit and the credit notice', async () => {
    await service.handleTransactionCompleted(
      txEvent({ type: 'TRANSFER', sourceAccountId: 'acc-0', sourceCustomerId: 'cust-1', destinationAccountId: 'acc-1', destinationCustomerId: 'cust-1' })
    );
    const subjects = mockEmailProvider.sendEmail.mock.calls.map((c: any[]) => c[0].subject);
    expect(subjects).toEqual([expect.stringContaining('debited from'), expect.stringContaining('credited to')]);
    expect(mockPrisma.notificationDelivery.create.mock.calls.map((c: any[]) => c[0].data.eventId)).toEqual(['evt-1:debit', 'evt-1:credit']);
  });

  it('ORDERING: if the contact is not known yet, the event is retried (transient), not dropped', async () => {
    mockPrisma.userContact.findUnique.mockResolvedValue(null);
    const err = await service.handleTransactionCompleted(txEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
  });

  it('SMTP OUTAGE: one attempt per Kafka try; the claim is released and the failure is transient (never dead-lettered)', async () => {
    mockEmailProvider.sendEmail.mockRejectedValue(smtpError('connect ECONNREFUSED', { code: 'ECONNREFUSED' }));
    const err = await service.dispatchEmail('evt-1', 'x', { recipient: 'a@b.com', subject: 's', body: 'b' }).catch((e) => e);
    expect(isTransientError(err)).toBe(true);
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notificationDelivery.deleteMany).toHaveBeenCalledWith({ where: { eventId: 'evt-1', recipient: 'a@b.com' } });
    expect(mockDlqPublisher.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['EAUTH (rotated credentials)', { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }],
    ['ETLS', { code: 'ETLS' }],
    ['EDNS', { code: 'EDNS' }],
    ['EPROTOCOL', { code: 'EPROTOCOL' }],
  ])('INFRASTRUCTURE failure %s: retryable, never DEAD_LETTER, event not marked processed', async (_label, fields) => {
    mockEmailProvider.sendEmail.mockRejectedValue(smtpError('smtp infrastructure failure', fields));
    const err = await service.handleTransactionCompleted(txEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationLog.create).not.toHaveBeenCalled();
    expect(mockDlqPublisher.publish).not.toHaveBeenCalled();
    expect(mockPrisma.notificationDelivery.deleteMany).toHaveBeenCalled();
  });

  it('CIRCUIT: while SMTP is known to be down, emails are not attempted at all; after the cool-down one probe goes through', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockEmailProvider.sendEmail.mockRejectedValueOnce(smtpError('timeout', { code: 'ETIMEDOUT' }));
    const opts = { recipient: 'a@b.com', subject: 's', body: 'b' };
    await expect(service.dispatchEmail('evt-1', 'x', opts)).rejects.toBeInstanceOf(TransientError);

    const skipped = await service.dispatchEmail('evt-2', 'x', opts).catch((e) => e);
    expect(skipped).toBeInstanceOf(TransientError);
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledTimes(1); // nothing claimed while open

    now += 30_001;
    expect(await service.dispatchEmail('evt-2', 'x', opts)).toBe('SENT');
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('PERMANENT failure (550 rejected recipient): one attempt, DEAD_LETTER without the address in last_error or the DLQ', async () => {
    mockEmailProvider.sendEmail.mockRejectedValue(
      smtpError('Recipient command failed: 550 5.1.1 <gone@b.com>: user unknown', { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' })
    );
    expect(await service.dispatchEmail('evt-9', 'x', { recipient: 'gone@b.com', subject: 's', body: 'b' })).toBe('DEAD_LETTER');
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);
    const log = mockPrisma.notificationLog.create.mock.calls[0][0].data;
    expect(log.status).toBe(NotificationStatus.DEAD_LETTER);
    expect(log.lastError).toContain('***@b.com');
    expect(log.lastError).not.toContain('gone@');
    const [topic, key, payload] = mockDlqPublisher.publish.mock.calls[0];
    expect([topic, key]).toEqual(['notifications.dlq', 'evt-9']);
    expect(payload).toEqual(expect.objectContaining({ originalEventId: 'evt-9', notificationLogId: 'log-1', recipientDomain: 'b.com' }));
    expect(JSON.stringify(payload)).not.toContain('gone@');
    // The (permanently rejected) delivery stays settled: a redelivery does not try again
    expect(mockPrisma.notificationDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it('DUPLICATES: a failed audit-log write after a successful send never causes a resend', async () => {
    mockPrisma.notificationLog.create.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P1001' }));
    expect(await service.dispatchEmail('evt-3', 'x', { recipient: 'a@b.com', subject: 's', body: 'b' })).toBe('SENT');
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);

    // ...and the redelivered message finds the claim and does not send again
    mockPrisma.notificationDelivery.create.mockRejectedValueOnce(unique());
    expect(await service.dispatchEmail('evt-3', 'x', { recipient: 'a@b.com', subject: 's', body: 'b' })).toBe('ALREADY_SENT');
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledTimes(1);
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
