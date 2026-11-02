/**
 * Top-up and refund money movements (transaction.completed.v1 ONLINE_TOP_UP / TOP_UP_REFUND), top-up status
 * emails (payment.updated.v1) and new-device sign-in alerts (security.new_device_login.v1).
 */
import { NotificationService, formatIst } from '../src/services/notification.service';
import { MailerEmailProvider } from '../src/providers/email.provider';
import { KafkaNotificationConsumer } from '../src/consumers/kafka-notification.consumer';
import { TransientError } from '@banksphere/common';

describe('top-ups, refunds and new-device alerts', () => {
  let mockPrisma: any;
  let mockEmailProvider: any;
  let service: NotificationService;
  const NOW = Date.now();

  beforeEach(() => {
    mockPrisma = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      notificationLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
      notificationDelivery: { create: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userContact: { findUnique: jest.fn().mockResolvedValue({ userId: 'cust-1', email: 'alice@bank.com' }), createMany: jest.fn() },
      accountOwner: { findUnique: jest.fn().mockResolvedValue(null), createMany: jest.fn() },
    };
    mockEmailProvider = { sendEmail: jest.fn().mockResolvedValue({ messageId: 'm-1' }) };
    service = new NotificationService(mockPrisma, mockEmailProvider, null);
  });

  const sent = () => mockEmailProvider.sendEmail.mock.calls.map((c: any[]) => c[0]);

  describe('transaction.completed.v1 for top-ups', () => {
    const txEvent = (overrides: Record<string, unknown> = {}) => ({
      eventId: 'evt-tx',
      eventType: 'transaction.completed.v1' as const,
      timestamp: new Date(NOW).toISOString(),
      transactionId: 'tx-1',
      referenceId: 'TOPUP-tu-1',
      type: 'ONLINE_TOP_UP' as const,
      amountInPaise: '50000',
      sourceAccountId: 'payment-clearing',
      destinationAccountId: 'acc-1',
      destinationCustomerId: 'cust-1',
      ...overrides,
    });

    it('ONLINE_TOP_UP: one money-in email saying it came through Razorpay; the clearing account side is never emailed', async () => {
      expect(await service.handleTransactionCompleted(txEvent())).toBe(true);
      expect(sent()).toHaveLength(1);
      const [email] = sent();
      expect(email.recipient).toBe('alice@bank.com');
      expect(email.subject).toBe('BankSphere Alert: ₹500.00 credited to your account (online top-up)');
      expect(email.body).toContain('₹500.00 has been added to your account through an online top-up via Razorpay (UPI, card or net banking).');
      expect(email.body).toContain('Transaction Reference: TOPUP-tu-1');
      expect(mockPrisma.accountOwner.findUnique).not.toHaveBeenCalled(); // no lookup for the clearing account
      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-tx:credit', recipient: 'alice@bank.com' } });
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({ data: { eventId: 'evt-tx', eventType: 'transaction.completed.v1' } });
    });

    it.each([
      ['upi', 'via Razorpay (UPI)'],
      ['card', 'via Razorpay (card)'],
      ['netbanking', 'via Razorpay (net banking)'],
      ['something-new', 'via Razorpay (UPI, card or net banking)'],
    ])('names the payment method when the ledger knows it (%s)', async (method, phrase) => {
      await service.handleTransactionCompleted(txEvent({ method }));
      expect(sent()[0].body).toContain(phrase);
    });

    it('TOP_UP_REFUND: one money-out email explaining the refund goes back to the original payment method', async () => {
      await service.handleTransactionCompleted(
        txEvent({ type: 'TOP_UP_REFUND', referenceId: 'TOPUP-REFUND-rf-1', sourceAccountId: 'acc-1', sourceCustomerId: 'cust-1', destinationAccountId: 'payment-clearing', destinationCustomerId: undefined })
      );
      expect(sent()).toHaveLength(1);
      const [email] = sent();
      expect(email.subject).toBe('BankSphere Alert: ₹500.00 debited from your account (top-up refund)');
      expect(email.body).toContain('₹500.00 has been debited from your account to refund your online top-up.');
      expect(email.body).toContain('original payment method');
      expect(email.body).not.toMatch(/credited to/);
      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-tx:debit', recipient: 'alice@bank.com' } });
    });

    it('is idempotent like every other transaction email', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue({ id: 'pe' });
      expect(await service.handleTransactionCompleted(txEvent())).toBe(false);
      expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
    });

    it('ordinary deposits keep their wording', async () => {
      await service.handleTransactionCompleted(txEvent({ type: 'DEPOSIT', sourceAccountId: undefined, referenceId: 'TXN-9' }));
      expect(sent()[0].subject).toBe('BankSphere Alert: ₹500.00 credited to your account');
      expect(sent()[0].body).toContain('₹500.00 has been credited to your account (DEPOSIT).');
    });
  });

  describe('payment.updated.v1', () => {
    const paymentEvent = (overrides: Record<string, unknown> = {}) => ({
      eventId: 'evt-pay',
      eventType: 'payment.updated.v1' as const,
      timestamp: new Date(NOW).toISOString(),
      topUpId: 'tu-1',
      customerId: 'cust-1',
      accountId: 'acc-1',
      amountInPaise: '125050',
      status: 'REFUNDED' as const,
      previousStatus: 'REFUND_PENDING' as const,
      ...overrides,
    });

    it('REFUNDED: "₹X refunded to your original payment method", claimed per event and marked processed', async () => {
      expect(await service.handlePaymentUpdated(paymentEvent({ method: 'card' }))).toBe(true);
      const [email] = sent();
      expect(email.recipient).toBe('alice@bank.com');
      expect(email.subject).toBe('BankSphere: ₹1,250.50 refunded to your original payment method');
      expect(email.body).toContain('₹1,250.50 from your online top-up has been refunded to your original payment method (the card you paid with).');
      expect(email.body).toContain('Top-up reference: tu-1');
      expect(email.body).toMatch(/few working days/);
      expect(mockPrisma.userContact.findUnique).toHaveBeenCalledWith({ where: { userId: 'cust-1' } });
      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-pay', recipient: 'alice@bank.com' } });
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({ data: { eventId: 'evt-pay', eventType: 'payment.updated.v1' } });
    });

    it('CREDIT_BLOCKED: "we received your payment but couldn\'t add it to your account; it will be refunded"', async () => {
      await service.handlePaymentUpdated(paymentEvent({ status: 'CREDIT_BLOCKED', previousStatus: 'CAPTURED', method: 'upi', failureReason: 'ACCOUNT_CLOSED' }));
      const [email] = sent();
      expect(email.subject).toBe("BankSphere: we couldn't add your ₹1,250.50 top-up to your account");
      expect(email.body).toContain("We received your payment of ₹1,250.50, but we couldn't add it to your BankSphere account because the account is closed.");
      expect(email.body).toContain('the full amount will be refunded to your original payment method (the UPI account you paid from)');
    });

    it.each([
      ['ACCOUNT_FROZEN', " because the account can't receive money right now"],
      ['ACCOUNT_NOT_CREDITABLE', " because the account can't receive money right now"],
      ['AMOUNT_MISMATCH', " because the amount paid didn't match the top-up"],
      ['ledger said: <script>owner mismatch for alice@bank.com</script>', ''],
    ])('CREDIT_BLOCKED reason %p is explained in plain words; unknown reasons are never echoed', async (failureReason, phrase) => {
      await service.handlePaymentUpdated(paymentEvent({ status: 'CREDIT_BLOCKED', failureReason }));
      const body = sent()[0].body;
      expect(body).toContain(`couldn't add it to your BankSphere account${phrase}.`);
      expect(body).not.toContain('<script>');
      expect(body).not.toContain('mismatch for');
    });

    it.each(['CREDITED', 'CREATED', 'PENDING', 'CAPTURED', 'REFUND_PENDING', 'FAILED', 'CANCELLED', 'EXPIRED'])(
      '%s: no email (CREDITED is covered by the ONLINE_TOP_UP money-in email), and no database work',
      async (status) => {
        expect(await service.handlePaymentUpdated(paymentEvent({ status }))).toBe(false);
        expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
        expect(mockPrisma.processedEvent.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
      }
    );

    it('IDEMPOTENT: a duplicate event is not emailed again', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValue({ id: 'pe' });
      expect(await service.handlePaymentUpdated(paymentEvent())).toBe(false);
      expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
    });

    it('waits (transient) for the customer\'s contact details instead of dropping the email', async () => {
      mockPrisma.userContact.findUnique.mockResolvedValue(null);
      await expect(service.handlePaymentUpdated(paymentEvent())).rejects.toBeInstanceOf(TransientError);
      expect(mockPrisma.processedEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      ['customerId', { customerId: undefined }],
      ['amount', { amountInPaise: '12.5' }],
      ['topUpId', { topUpId: '' }],
    ])('a malformed emailable event (%s) is a permanent error (dead-lettered)', async (_label, overrides) => {
      const err = await service.handlePaymentUpdated(paymentEvent(overrides)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TransientError);
      expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('security.new_device_login.v1', () => {
    const loginEvent = (overrides: Record<string, unknown> = {}) => ({
      eventId: 'evt-dev',
      eventType: 'security.new_device_login.v1' as const,
      timestamp: '2026-10-28T14:05:10.000Z',
      userId: 'cust-1',
      email: 'alice@bank.com',
      deviceLabel: 'Chrome on Windows',
      ipMasked: '203.0.113.x',
      at: '2026-10-28T14:05:09.000Z',
      ...overrides,
    });

    it('"New sign-in to BankSphere": device, approximate network, time in IST, and what to do if it was not them', async () => {
      expect(await service.handleNewDeviceLogin(loginEvent())).toBe(true);
      const [email] = sent();
      expect(email.recipient).toBe('alice@bank.com');
      expect(email.subject).toBe('New sign-in to BankSphere');
      expect(email.body).toContain('Device: Chrome on Windows');
      expect(email.body).toContain('Approximate network: 203.0.113.x');
      expect(email.body).toContain('Time: 28 Oct 2026, 7:35 PM IST');
      expect(email.body).toMatch(/If this wasn't you.*Security.*Sign out everywhere else.*change your password/s);
      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledWith({ data: { eventId: 'evt-dev', recipient: 'alice@bank.com' } });
      expect(mockPrisma.processedEvent.create).toHaveBeenCalledWith({ data: { eventId: 'evt-dev', eventType: 'security.new_device_login.v1' } });
    });

    it('IDEMPOTENT: a duplicate is not emailed again; a claimed delivery is not resent', async () => {
      mockPrisma.processedEvent.findUnique.mockResolvedValueOnce({ id: 'pe' });
      expect(await service.handleNewDeviceLogin(loginEvent())).toBe(false);
      mockPrisma.notificationDelivery.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      await service.handleNewDeviceLogin(loginEvent());
      expect(mockEmailProvider.sendEmail).not.toHaveBeenCalled();
    });

    it('goes to the address ON FILE: an event can never redirect a security alert', async () => {
      await service.handleNewDeviceLogin(loginEvent({ email: 'attacker@evil.example' }));
      expect(sent()[0].recipient).toBe('alice@bank.com');
    });

    it('uses the (auth-service) address in the event when none is on file yet, so the alert is not delayed', async () => {
      mockPrisma.userContact.findUnique.mockResolvedValue(null);
      await service.handleNewDeviceLogin(loginEvent({ email: 'new.user@bank.com' }));
      expect(sent()[0].recipient).toBe('new.user@bank.com');
    });

    it('waits (transient) when there is no usable address at all', async () => {
      mockPrisma.userContact.findUnique.mockResolvedValue(null);
      // A fresh event: contactMissing() waits only while the event is young, then skips for good
      await expect(service.handleNewDeviceLogin(loginEvent({ email: 'not-an-address', timestamp: new Date(NOW).toISOString() }))).rejects.toBeInstanceOf(TransientError);
    });

    it('the device label (derived from the attacker-controlled User-Agent) cannot inject text, links or markup', async () => {
      await service.handleNewDeviceLogin(loginEvent({ deviceLabel: 'Chrome\n\nCall 18005550199 or visit evil.example to <b>secure</b> your account' }));
      const options = sent()[0];
      expect(options.body).toContain('Device: Unrecognised device');
      expect(options.body).not.toMatch(/evil\.example|18005550199|<b>/);

      await service.handleNewDeviceLogin(loginEvent({ eventId: 'evt-dev-2', deviceLabel: 'Firefox 128.0 on <Linux>' }));
      expect(sent()[1].body).toContain('Device: Firefox 128.0 on Linux');
      const mailer = { send: jest.fn().mockResolvedValue({ messageId: 'x' }) };
      await new MailerEmailProvider(mailer).sendEmail(sent()[1]);
      expect(mailer.send.mock.calls[0][0].html).not.toContain('<Linux>');
    });

    it('an implausible network is shown as unknown', async () => {
      await service.handleNewDeviceLogin(loginEvent({ ipMasked: '203.0.113.7 (call us)' }));
      expect(sent()[0].body).toContain('Approximate network: unknown');
    });

    it('falls back to the event time when `at` is missing', async () => {
      await service.handleNewDeviceLogin(loginEvent({ at: undefined }));
      expect(sent()[0].body).toContain('Time: 28 Oct 2026, 7:35 PM IST');
    });

    it.each([
      ['userId', { userId: undefined }],
      ['time', { at: 'yesterday', timestamp: 'nope' }],
    ])('a malformed event (%s) is a permanent error (dead-lettered)', async (_label, overrides) => {
      const err = await service.handleNewDeviceLogin(loginEvent(overrides)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TransientError);
    });
  });

  it('formats times in IST (UTC+05:30, no daylight saving), 12-hour clock', () => {
    expect(formatIst(new Date('2026-10-28T14:05:09Z'))).toBe('28 Oct 2026, 7:35 PM IST');
    expect(formatIst(new Date('2026-10-28T18:30:00Z'))).toBe('29 Oct 2026, 12:00 AM IST');
    expect(formatIst(new Date('2026-10-28T06:30:00Z'))).toBe('28 Oct 2026, 12:00 PM IST');
    expect(formatIst(new Date('2026-12-31T18:29:00Z'))).toBe('31 Dec 2026, 11:59 PM IST');
  });

  it('the consumer subscribes to payment.updated.v1 and security.new_device_login.v1 and routes them', async () => {
    const kafka = { subscribe: jest.fn() };
    const payment = jest.spyOn(service, 'handlePaymentUpdated').mockResolvedValue(true);
    const device = jest.spyOn(service, 'handleNewDeviceLogin').mockResolvedValue(true);
    new KafkaNotificationConsumer(kafka as any, service).start();
    const [groupId, topics, handler, options] = kafka.subscribe.mock.calls[0];
    expect(groupId).toBe('notification-service-group');
    expect(topics).toEqual([
      'user.registered.v1',
      'transaction.completed.v1',
      'account.created.v1',
      'account.status.changed.v1',
      'fraud.alert.created.v1',
      'withdrawal.code.created.v1',
      'beneficiary.added.v1',
      'payment.updated.v1',
      'security.new_device_login.v1',
    ]);
    expect(options).toEqual({ retryNamespace: 'notification' });
    await handler('payment.updated.v1', { eventId: 'e1' });
    await handler('security.new_device_login.v1', { eventId: 'e2' });
    expect(payment).toHaveBeenCalledWith({ eventId: 'e1' });
    expect(device).toHaveBeenCalledWith({ eventId: 'e2' });
  });
});
