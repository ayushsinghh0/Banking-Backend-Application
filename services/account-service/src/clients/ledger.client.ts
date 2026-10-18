import {
  BadGatewayError,
  INTERNAL_TOKEN_HEADER,
  getInternalServiceToken,
} from '@banksphere/common';

export interface LedgerAccountProvisioning {
  id: string;
  accountNumber: string;
  customerId: string;
  currency: string;
  dailyLimitPaise: string;
  isActive: boolean;
}

export interface LedgerAccountUpdate {
  isActive?: boolean;
  dailyLimitPaise?: string;
}

export interface LedgerAccountSnapshot {
  id: string;
  balanceInPaise: string;
  isActive: boolean;
}

/**
 * Internal client for the Transaction & Ledger service. The ledger is the system of record
 * for balances and for whether money may move, so account lifecycle changes are pushed to it
 * synchronously instead of eventually via Kafka.
 */
export interface LedgerClient {
  provisionAccount(input: LedgerAccountProvisioning): Promise<void>;
  updateAccount(accountId: string, input: LedgerAccountUpdate): Promise<void>;
  getAccount(accountId: string): Promise<LedgerAccountSnapshot>;
}

export class HttpLedgerClient implements LedgerClient {
  constructor(
    private readonly baseUrl = process.env.LEDGER_SERVICE_URL || 'http://localhost:8004',
    private readonly timeoutMs = 5000
  ) {}

  public async provisionAccount(input: LedgerAccountProvisioning): Promise<void> {
    await this.request('POST', '/internal/v1/ledger-accounts', input);
  }

  public async updateAccount(accountId: string, input: LedgerAccountUpdate): Promise<void> {
    await this.request('PATCH', `/internal/v1/ledger-accounts/${encodeURIComponent(accountId)}`, input);
  }

  public async getAccount(accountId: string): Promise<LedgerAccountSnapshot> {
    const body = await this.request(
      'GET',
      `/internal/v1/ledger-accounts/${encodeURIComponent(accountId)}`
    );
    return body.data as LedgerAccountSnapshot;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: getInternalServiceToken(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BadGatewayError('Ledger service is unreachable');
    }

    const text = await response.text();
    if (!response.ok) {
      throw new BadGatewayError(`Ledger service rejected the request (HTTP ${response.status})`);
    }
    return text ? JSON.parse(text) : {};
  }
}
