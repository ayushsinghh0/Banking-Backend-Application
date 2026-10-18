import { KafkaService, logger } from '@banksphere/common';
import { FraudService } from '../services/fraud.service';
import { TransactionEvaluationContext } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KafkaFraudConsumer {
  constructor(
    private readonly kafkaService: KafkaService,
    private readonly fraudService: FraudService,
    private readonly groupId = process.env.KAFKA_CONSUMER_GROUP || 'fraud-service-group'
  ) {}

  /**
   * Scores both sides of every completed transaction: the account money left (OUTBOUND) and the
   * account it arrived in (INBOUND), so mule accounts receiving bursts of funds are flagged too.
   */
  public start(): void {
    this.kafkaService.subscribe(this.groupId, ['transaction.completed.v1'], async (_topic: string, payload: any) => {
      const valid =
        typeof payload?.eventId === 'string' &&
        UUID.test(String(payload?.transactionId)) &&
        /^\d{1,18}$/.test(String(payload?.amountInPaise)) &&
        (UUID.test(String(payload?.sourceAccountId)) || UUID.test(String(payload?.destinationAccountId)));
      if (!valid) {
        // A malformed event will never succeed: throw a non-transient error so it ends in the DLQ
        logger.error({ eventId: payload?.eventId }, 'Malformed transaction.completed.v1 event');
        throw new Error('Malformed transaction.completed.v1 event');
      }

      const base = {
        transactionId: payload.transactionId as string,
        amountInPaise: BigInt(payload.amountInPaise),
        timestamp: new Date(payload.timestamp || Date.now()),
        transactionType: typeof payload.type === 'string' ? payload.type : undefined,
        initiatedBy: typeof payload.initiatedBy === 'string' ? payload.initiatedBy : undefined,
        cashOperationId: typeof payload.cashOperationId === 'string' ? payload.cashOperationId : undefined,
      };
      const sides: TransactionEvaluationContext[] = [];
      if (payload.sourceAccountId) sides.push({ ...base, accountId: payload.sourceAccountId, direction: 'OUTBOUND' });
      if (payload.destinationAccountId) sides.push({ ...base, accountId: payload.destinationAccountId, direction: 'INBOUND' });

      for (const context of sides) {
        await this.fraudService.evaluateTransaction(context, payload.eventId);
      }
    });
  }
}
