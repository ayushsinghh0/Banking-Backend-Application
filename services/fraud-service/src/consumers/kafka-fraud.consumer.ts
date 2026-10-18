import { Consumer } from 'kafkajs';
import { KafkaService } from '@banksphere/common';
import { FraudService } from '../services/fraud.service';

export class KafkaFraudConsumer {
  private consumer: Consumer | null = null;

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly fraudService: FraudService,
    private readonly groupId = process.env.KAFKA_CONSUMER_GROUP || 'fraud-service-group'
  ) {}

  public async start(): Promise<void> {
    this.consumer = await this.kafkaService.subscribe(
      this.groupId,
      ['transaction.completed.v1'],
      async (_topic: string, payload: any) => {
        const amountInPaise = BigInt(payload.amountInPaise || '0');
        const accountId = payload.sourceAccountId || payload.destinationAccountId || 'unknown-account';

        await this.fraudService.evaluateTransaction(
          {
            transactionId: payload.transactionId,
            accountId,
            amountInPaise,
            timestamp: new Date(payload.timestamp || Date.now()),
          },
          payload.eventId
        );
      }
    );
  }

  public async stop(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }
  }
}
