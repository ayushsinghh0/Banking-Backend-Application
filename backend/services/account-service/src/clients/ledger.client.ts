import {
  BadGatewayError,
  INTERNAL_TOKEN_HEADER,
  HttpError,
  getInternalToken,
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
  /** Control-state version; the ledger applies it only if newer than its own */
  version: number;
}

export interface LedgerAccountSnapshot {
  id: string;
  balanceInPaise: string;
  dailyLimitPaise: string;
  isActive: boolean;
  closed: boolean;
  controlVersion: number;
}

/**
 * Internal client for the Transaction & Ledger service. The ledger is the system of record
 * for balances and for whether money may move, so account lifecycle changes are pushed to it
 * synchronously instead of eventually via Kafka.
 */
export interface LedgerClient {
  provisionAccount(input: LedgerAccountProvisioning): Promise<void>;
  updateAccount(accountId: string, input: LedgerAccountUpdate): Promise<{ applied: boolean }>;
  getAccount(accountId: string): Promise<LedgerAccountSnapshot>;
  getAccounts(accountIds: string[]): Promise<LedgerAccountSnapshot[]>;
  /** Ledger-side close: refuses (409 BALANCE_NOT_ZERO) unless the balance is zero, checked under lock */
  closeAccount(accountId: string, version: number): Promise<void>;
}

export class HttpLedgerClient implements LedgerClient {
  constructor(
    private readonly baseUrl = process.env.LEDGER_SERVICE_URL || 'http://localhost:8004',
    private readonly timeoutMs = 5000
  ) {}

  public async provisionAccount(input: LedgerAccountProvisioning): Promise<void> {
    await this.request('POST', '/internal/v1/ledger-accounts', input);
  }

  public async updateAccount(accountId: string, input: LedgerAccountUpdate): Promise<{ applied: boolean }> {
    const body = await this.request('PATCH', `/internal/v1/ledger-accounts/${encodeURIComponent(accountId)}`, input);
    return { applied: Boolean(body?.data?.applied) };
  }

  public async getAccount(accountId: string): Promise<LedgerAccountSnapshot> {
    const body = await this.request(
      'GET',
      `/internal/v1/ledger-accounts/${encodeURIComponent(accountId)}`
    );
    return body.data as LedgerAccountSnapshot;
  }

  public async getAccounts(accountIds: string[]): Promise<LedgerAccountSnapshot[]> {
    const body = await this.request('POST', '/internal/v1/ledger-accounts/snapshots', { ids: accountIds });
    return body.data as LedgerAccountSnapshot[];
  }

  public async closeAccount(accountId: string, version: number): Promise<void> {
    await this.request('POST', `/internal/v1/ledger-accounts/${encodeURIComponent(accountId)}/close`, { version });
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: getInternalToken('LEDGER_INTERNAL_TOKEN'),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BadGatewayError('Ledger service is unreachable');
    }

    const text = await response.text();
    if (response.status === 409) {
      // Business rule from the ledger (e.g. BALANCE_NOT_ZERO): surface it to the caller as-is
      const err = JSON.parse(text || '{}')?.error;
      throw new HttpError(409, err?.code || 'CONFLICT', err?.message || 'Ledger refused the change');
    }
    if (!response.ok) {
      throw new BadGatewayError(`Ledger service rejected the request (HTTP ${response.status})`);
    }
    return text ? JSON.parse(text) : {};
  }
}
