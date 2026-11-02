import { Request } from 'express';
import { AuthenticatedUser, ServiceClient } from '@banksphere/common';

/**
 * Read-only calls to the services that own the data. Every call forwards the customer's own access token (and
 * their address, correlation id and trace), so the owning service authenticates and authorizes the customer
 * exactly as it would for the app: the assistant can never see more than the customer can.
 */
export interface ToolContext {
  user: AuthenticatedUser;
  request: Request;
  signal: AbortSignal;
}

export interface UpstreamAccount {
  id: string;
  accountNumber?: string;
  accountType?: string;
  status?: string;
  currency?: string;
  dailyLimitPaise?: string;
}

export interface UpstreamBalance {
  accountId: string;
  balanceInPaise: string;
  currency?: string;
}

export interface UpstreamHistoryEntry {
  entryId: string;
  transactionId: string;
  type?: string;
  entryType: 'DEBIT' | 'CREDIT';
  amountInPaise: string;
  description?: string | null;
  createdAt: string;
}

export interface UpstreamBeneficiary {
  id: string;
  accountNumber?: string;
  nickname: string;
  activatesAt?: string;
  createdAt?: string;
}

export interface UpstreamTopUp {
  id: string;
  accountNumberLast4?: string;
  amountPaise: string;
  status: string;
  failureReason?: string | null;
  createdAt: string;
  creditedAt?: string | null;
}

export interface UpstreamPaymentConfig {
  limits?: {
    minPaise?: string;
    maxPaise?: string;
    dailyLimitPaise?: string;
    usedTodayPaise?: string;
    remainingTodayPaise?: string;
  };
}

export interface UpstreamProfile {
  kycStatus?: string;
}

export interface BankingApi {
  listAccounts(ctx: ToolContext): Promise<UpstreamAccount[]>;
  getBalance(ctx: ToolContext, accountId: string): Promise<UpstreamBalance>;
  getHistory(ctx: ToolContext, accountId: string, limit: number, offset: number): Promise<UpstreamHistoryEntry[]>;
  listBeneficiaries(ctx: ToolContext): Promise<UpstreamBeneficiary[]>;
  getProfile(ctx: ToolContext): Promise<UpstreamProfile>;
  listTopUps(ctx: ToolContext, limit: number): Promise<UpstreamTopUp[]>;
  getPaymentConfig(ctx: ToolContext): Promise<UpstreamPaymentConfig>;
}

export interface HttpBankingApiOptions {
  accountUrl: string;
  transactionUrl: string;
  customerUrl: string;
  paymentUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A list arrives bare or as `{ items }` */
function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

export class HttpBankingApi implements BankingApi {
  private readonly accounts: ServiceClient;
  private readonly ledger: ServiceClient;
  private readonly customers: ServiceClient;
  private readonly payments: ServiceClient;

  constructor(options: HttpBankingApiOptions) {
    // One retry: a chat answer is interactive, so a struggling upstream should produce a quick friendly answer
    const common = { timeoutMs: options.timeoutMs ?? 5_000, retries: 1, fetchImpl: options.fetchImpl };
    this.accounts = new ServiceClient({ name: 'account-service', baseUrl: options.accountUrl, ...common });
    this.ledger = new ServiceClient({ name: 'transaction-service', baseUrl: options.transactionUrl, ...common });
    this.customers = new ServiceClient({ name: 'customer-service', baseUrl: options.customerUrl, ...common });
    this.payments = new ServiceClient({ name: 'payment-service', baseUrl: options.paymentUrl, ...common });
  }

  private call(ctx: ToolContext, query?: Record<string, string | number>) {
    return { context: ctx.request, forwardAuth: true, signal: ctx.signal, query };
  }

  public async listAccounts(ctx: ToolContext): Promise<UpstreamAccount[]> {
    return listOf<UpstreamAccount>(await this.accounts.get('/api/v1/accounts', this.call(ctx)));
  }

  public getBalance(ctx: ToolContext, accountId: string): Promise<UpstreamBalance> {
    return this.ledger.get<UpstreamBalance>(`/api/v1/transactions/accounts/${encodeURIComponent(accountId)}/balance`, this.call(ctx));
  }

  public async getHistory(ctx: ToolContext, accountId: string, limit: number, offset: number): Promise<UpstreamHistoryEntry[]> {
    const data = await this.ledger.get(
      `/api/v1/transactions/accounts/${encodeURIComponent(accountId)}/history`,
      this.call(ctx, { limit, offset })
    );
    return listOf<UpstreamHistoryEntry>(data);
  }

  public async listBeneficiaries(ctx: ToolContext): Promise<UpstreamBeneficiary[]> {
    return listOf<UpstreamBeneficiary>(await this.ledger.get('/api/v1/transactions/beneficiaries', this.call(ctx)));
  }

  public async getProfile(ctx: ToolContext): Promise<UpstreamProfile> {
    return (await this.customers.get<UpstreamProfile>('/api/v1/customers/me', this.call(ctx))) ?? {};
  }

  public async listTopUps(ctx: ToolContext, limit: number): Promise<UpstreamTopUp[]> {
    return listOf<UpstreamTopUp>(await this.payments.get('/api/v1/payments/top-ups', this.call(ctx, { limit })));
  }

  public async getPaymentConfig(ctx: ToolContext): Promise<UpstreamPaymentConfig> {
    return (await this.payments.get<UpstreamPaymentConfig>('/api/v1/payments/config', this.call(ctx))) ?? {};
  }
}
