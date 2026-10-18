export interface BaseEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  correlationId?: string;
}

export interface TransactionCompletedEvent extends BaseEvent {
  eventType: 'transaction.completed.v1';
  transactionId: string;
  referenceId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER';
  amountInPaise: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
}

export interface AccountCreatedEvent extends BaseEvent {
  eventType: 'account.created.v1';
  accountId: string;
  accountNumber: string;
  customerId: string;
  accountType: 'SAVINGS' | 'CURRENT';
  currency: string;
}

export interface FraudAlertCreatedEvent extends BaseEvent {
  eventType: 'fraud.alert.created.v1';
  alertId: string;
  transactionId: string;
  accountId: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reason: string;
}

export interface EmailDispatchOptions {
  recipient: string;
  subject: string;
  body: string;
  metadata?: Record<string, any>;
}
