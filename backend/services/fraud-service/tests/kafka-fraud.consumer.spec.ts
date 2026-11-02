import { KafkaFraudConsumer } from '../src/consumers/kafka-fraud.consumer';

const ALICE_ACC = '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01';
const BOB_ACC = '7c2d4e61-1e66-4cc5-8b54-7a1e9a2b1b02';
const ALICE = 'd2a3b4c5-0001-4000-8000-000000000001';
const TXN = 'e3b4c5d6-0002-4000-8000-000000000002';
const TOP_UP = 'f4c5d6e7-0003-4000-8000-000000000003';
const AT = '2026-10-30T10:00:00.000Z';

type Handler = (topic: string, payload: any) => Promise<void>;

/** Captures the handler the consumer registers, instead of connecting to Kafka */
function setup() {
  const subscribe = jest.fn();
  const fraudService = { evaluateTransaction: jest.fn().mockResolvedValue({ alertCreated: false }) };
  new KafkaFraudConsumer({ subscribe } as any, fraudService as any, 'fraud-test-group').start();
  const [groupId, topics, handler, options] = subscribe.mock.calls[0];
  return { groupId, topics, handler: handler as Handler, options, fraudService };
}

/** What transaction-service's outbox publishes (ledger-core stageTransactionEvent + the posting's payload) */
const event = (payload: Record<string, unknown>) => ({
  eventId: 'evt-1',
  eventType: 'transaction.completed.v1',
  timestamp: AT,
  transactionId: TXN,
  status: 'COMPLETED',
  currency: 'INR',
  ...payload,
});

describe('KafkaFraudConsumer: transaction.completed.v1', () => {
  it('subscribes to transaction.completed.v1 with its own retry namespace', () => {
    const { groupId, topics, options } = setup();
    expect([groupId, topics, options]).toEqual(['fraud-test-group', ['transaction.completed.v1'], { retryNamespace: 'fraud' }]);
  });

  it('TRANSFER: scores both sides, the sender OUTBOUND and the receiver INBOUND, under the same event id', async () => {
    const { handler, fraudService } = setup();
    await handler('transaction.completed.v1', event({ type: 'TRANSFER', amountInPaise: '500000', sourceAccountId: ALICE_ACC, destinationAccountId: BOB_ACC, initiatedBy: ALICE }));
    expect(fraudService.evaluateTransaction.mock.calls.map(([ctx, eventId]: any[]) => [ctx.accountId, ctx.direction, ctx.transactionType, eventId])).toEqual([
      [ALICE_ACC, 'OUTBOUND', 'TRANSFER', 'evt-1'],
      [BOB_ACC, 'INBOUND', 'TRANSFER', 'evt-1'],
    ]);
  });

  it('ONLINE_TOP_UP: scores the customer account INBOUND only (PAYMENT_CLEARING is not in the event), typed for the rules', async () => {
    const { handler, fraudService } = setup();
    await handler(
      'transaction.completed.v1',
      event({
        type: 'ONLINE_TOP_UP',
        referenceId: `TOPUP-${TOP_UP}`,
        amountInPaise: '25000000',
        destinationAccountId: ALICE_ACC,
        destinationCustomerId: ALICE,
        initiatedBy: ALICE,
        topUpId: TOP_UP,
      })
    );
    expect(fraudService.evaluateTransaction).toHaveBeenCalledTimes(1);
    expect(fraudService.evaluateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: TXN,
        accountId: ALICE_ACC,
        direction: 'INBOUND',
        amountInPaise: 25_000_000n,
        timestamp: new Date(AT),
        transactionType: 'ONLINE_TOP_UP',
        initiatedBy: ALICE,
      }),
      'evt-1'
    );
  });

  it('TOP_UP_REFUND: scores the customer account OUTBOUND only, on behalf of payment-service, typed so velocity ignores it', async () => {
    const { handler, fraudService } = setup();
    await handler(
      'transaction.completed.v1',
      event({
        type: 'TOP_UP_REFUND',
        referenceId: `TOPUP-REFUND-${TOP_UP}`,
        amountInPaise: '25000000',
        sourceAccountId: ALICE_ACC,
        sourceCustomerId: ALICE,
        initiatedBy: 'payment-service',
        topUpId: TOP_UP,
        refundId: TOP_UP,
      })
    );
    expect(fraudService.evaluateTransaction).toHaveBeenCalledTimes(1);
    expect(fraudService.evaluateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ALICE_ACC, direction: 'OUTBOUND', amountInPaise: 25_000_000n, transactionType: 'TOP_UP_REFUND', initiatedBy: 'payment-service' }),
      'evt-1'
    );
  });

  it('a malformed event is refused for good (a non-transient error, so it ends in the dead-letter topic)', async () => {
    const { handler, fraudService } = setup();
    await expect(handler('transaction.completed.v1', event({ type: 'ONLINE_TOP_UP', amountInPaise: 'lots', destinationAccountId: ALICE_ACC }))).rejects.toThrow(/Malformed/);
    await expect(handler('transaction.completed.v1', event({ type: 'TRANSFER', amountInPaise: '100' }))).rejects.toThrow(/Malformed/); // no account at all
    await expect(handler('transaction.completed.v1', { ...event({ amountInPaise: '100', sourceAccountId: ALICE_ACC }), eventId: 7 })).rejects.toThrow(/Malformed/);
    expect(fraudService.evaluateTransaction).not.toHaveBeenCalled();
  });
});
