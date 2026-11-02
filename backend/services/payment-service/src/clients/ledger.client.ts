import { Request } from 'express';
import { ServiceClient } from '@banksphere/common';

/** GET /internal/v1/payments/accounts/:accountId (404 unless a CUSTOMER account) */
export interface LedgerPaymentAccount {
  accountId: string;
  customerId: string;
  accountNumberLast4: string;
  isActive: boolean;
  closed: boolean;
}

export interface LedgerPosting {
  transactionId: string;
  referenceId: string;
  replayed: boolean;
}

/**
 * The ledger's payments API (transaction-service `/internal/v1/payments`, design section 6), authenticated with
 * PAYMENT_LEDGER_INTERNAL_TOKEN: it can read customer accounts and post top-up credits and refund debits, and
 * nothing else. Every posting is idempotent on our ids, so a retry after a timeout can never post twice.
 *   - credit: 409 ACCOUNT_NOT_CREDITABLE when the account is inactive, closed or not the customer's
 *   - refund: 409 INSUFFICIENT_FUNDS (bank-initiated: no daily limit, but never overdraws)
 */
export interface LedgerApi {
  getAccount(accountId: string, context?: Request): Promise<LedgerPaymentAccount>;
  credit(input: { topUpId: string; accountId: string; customerId: string; amountPaise: bigint; providerPaymentId: string }): Promise<LedgerPosting>;
  debitRefund(input: { refundId: string; topUpId: string; accountId: string; customerId: string; amountPaise: bigint }): Promise<LedgerPosting>;
  reverseRefund(refundId: string): Promise<LedgerPosting>;
}

export class HttpLedgerClient implements LedgerApi {
  constructor(private readonly client: ServiceClient) {}

  static create(baseUrl: string, internalToken: string): HttpLedgerClient {
    return new HttpLedgerClient(new ServiceClient({ name: 'ledger-payments', baseUrl, internalToken, timeoutMs: 5_000 }));
  }

  public getAccount(accountId: string, context?: Request): Promise<LedgerPaymentAccount> {
    return this.client.get(`/internal/v1/payments/accounts/${encodeURIComponent(accountId)}`, { context });
  }

  public credit(input: { topUpId: string; accountId: string; customerId: string; amountPaise: bigint; providerPaymentId: string }) {
    return this.client.post<LedgerPosting>('/internal/v1/payments/credits', { ...input, amountPaise: input.amountPaise.toString() });
  }

  public debitRefund(input: { refundId: string; topUpId: string; accountId: string; customerId: string; amountPaise: bigint }) {
    return this.client.post<LedgerPosting>('/internal/v1/payments/refunds', { ...input, amountPaise: input.amountPaise.toString() });
  }

  public reverseRefund(refundId: string) {
    return this.client.post<LedgerPosting>(`/internal/v1/payments/refunds/${encodeURIComponent(refundId)}/reverse`);
  }
}
