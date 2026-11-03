import { NotificationService } from '../src/services/notification.service';
import { MailerEmailProvider } from '../src/providers/email.provider';
import { KafkaNotificationConsumer } from '../src/consumers/kafka-notification.consumer';
import { TransientError } from '@banksphere/common';

describe('beneficiary.added.v1 security notice', () => {
  let mockPrisma: any;
  let mockEmailProvider: any;
  let service: NotificationService;

  const now = Date.now();
  const event = (overrides: Partial<any> = {}) => ({
    eventId: 'evt-ben-1',
    eventType: 'beneficiary.added.v1' as const,
    timestamp: new Date(now).toISOString(),
    customerId: 'cust-1',
    beneficiaryId: 'ben-1',
    accountNumberLast4: '1234',
    nickname: 'Mom',
    activatesAt: new Date(now + 3600_000).toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    mockPrisma = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      notificationLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
      notificationDelivery: { create: jest.fn(), deleteMany: jest.fn() },
      userContact: { findUnique: jest.fn().mockResolvedValue({ userId: 'cust-1', email: 'alice@bank.com' }) },
      accountOwner: { findUnique: jest.fn(), createMany: jest.fn() },
    };
    mockEmailProvider = { sendEmail: jest.fn().mockResolvedValue({ messageId: 'm-1' }) };
    service = new NotificationService(mockPrisma, mockEmailProvider, null);
  });

  it('emails the customer: payee nickname, masked account number, activation time and what to do if it was not them', async () => {
    expect(await service.handleBeneficiaryAdded(event())).toBe(true);
    expect(mockPrisma.userContact.findUnique).toHaveBeenCalledWith({ where: { userId: 'cust-1' } });
    const email = mockEmailProvider.sendEmail.mock.calls[0][0];
    expect(email.recipient).toBe('alice@bank.com');
    expect(email.subject).toMatch(/a new payee was added/i);
    expect(email.body).toContain('Mom');
    expect(email.body).toContain('••••1234');
    expect(email.body).toContain(new Date(now + 3600_000).toISOString().slice(0, 16).replace('T', ' '));
    expect(email.body).toMatch(/If this wasn't you, freeze your account and contact the bank/);
    expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-ben-1', recipient: 'alice@bank.com' } });
    expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({ data: { eventId: 'evt-ben-1', eventType: 'beneficiary.added.v1' } });
  });

  it('says the payee is active immediately when it was added with a fresh step-up', async () => {
    await service.handleBeneficiaryAdded(event({ activatesAt: new Date(now).toISOString() }));
    expect(mockEmailProvider.sendEmail.mock.calls[0][0].body).toMatch(/active immediately/i);
  });

  it('the attacker-controlled nickname cannot inject paragraphs, and is HTML-escaped in the rendered email', async () => {
    await service.handleBeneficiaryAdded(event({ nickname: 'Mom\n\n<a href="https://evil.example">Verify now</a>' }));
    const options = mockEmailProvider.sendEmail.mock.calls[0][0];
    const payeeParagraph = options.body.split(/\n{2,}/).find((p: string) => p.includes('Mom'));
    expect(payeeParagraph).toContain('Verify now'); // stays inside the payee paragraph

    const mailer = { send: jest.fn().mockResolvedValue({ messageId: 'x' }) };
    await new MailerEmailProvider(mailer).sendEmail(options);
    const { html, text } = mailer.send.mock.calls[0][0];
    expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(text).toContain('••••1234');
  });

  it('never shows more than the last four digits', async () => {
    await service.handleBeneficiaryAdded(event({ accountNumberLast4: '100112345678' }));
    const body = mockEmailProvider.sendEmail.mock.calls[0][0].body;
    expect(body).toContain('••••5678');
    expect(body).not.toContain('10011234');
  });

  it('waits (transient) for the contact details instead of dropping the notice', async () => {
    mockPrisma.userContact.findUnique.mockResolvedValue(null);
    await expect(service.handleBeneficiaryAdded(event())).rejects.toBeInstanceOf(TransientError);
    expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
  });

  it('is idempotent per event', async () => {
    mockPrisma.processedEvent.findUnique.mockResolvedValue({ id: 'pe' });
    expect(await service.handleBeneficiaryAdded(event())).toBe(false);
    expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['customerId', { customerId: undefined }],
    ['account digits', { accountNumberLast4: 'ab' }],
    ['activatesAt', { activatesAt: 'not a date' }],
  ])('a malformed event (%s) is a permanent error (dead-lettered by the consumer)', async (_label, overrides) => {
    const err = await service.handleBeneficiaryAdded(event(overrides)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
  });

  it('the notification consumer subscribes to beneficiary.added.v1 and routes it to the handler', async () => {
    const kafka = { subscribe: jest.fn() };
    const handle = jest.spyOn(service, 'handleBeneficiaryAdded').mockResolvedValue(true);
    new KafkaNotificationConsumer(kafka as any, service).start();
    const [, topics, handler, options] = kafka.subscribe.mock.calls[0];
    expect(topics).toContain('beneficiary.added.v1');
    expect(options).toEqual(expect.objectContaining({ retryNamespace: 'notification' }));
    await handler('beneficiary.added.v1', event());
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-ben-1' }));
  });
});
