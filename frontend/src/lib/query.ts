import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isApiError } from './api/errors';

/** Retry only what is safe and likely to succeed: transport failures and explicit "busy" responses */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  return isApiError(error) && error.isRetryable;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache(),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt, error) =>
          isApiError(error) && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: true,
      },
      // Money-moving mutations are never retried automatically: the person decides, with the same idempotency key
      mutations: { retry: false },
    },
  });
}

/** Query keys in one place so mutations invalidate exactly what they change */
export const qk = {
  me: ['auth', 'me'] as const,
  profile: ['customers', 'me'] as const,
  accounts: ['accounts'] as const,
  account: (id: string) => ['accounts', id] as const,
  balance: (id: string) => ['ledger', 'balance', id] as const,
  balances: ['ledger', 'balance'] as const,
  history: (id: string, offset: number, limit: number) => ['ledger', 'history', id, offset, limit] as const,
  historyAll: ['ledger', 'history'] as const,
  beneficiaries: ['ledger', 'beneficiaries'] as const,
  tellerSession: ['teller', 'session'] as const,
  cashOperations: (status?: string, offset = 0) => ['teller', 'cash-operations', status ?? 'all', offset] as const,
  cashOperationsAll: ['teller', 'cash-operations'] as const,
  sessions: (status?: string, offset = 0) => ['supervisor', 'sessions', status ?? 'all', offset] as const,
  sessionsAll: ['supervisor', 'sessions'] as const,
  customers: (params: object) => ['customers', 'list', params] as const,
  customersAll: ['customers', 'list'] as const,
  customer: (userId: string) => ['customers', 'detail', userId] as const,
  kycHistory: (userId: string) => ['customers', 'kyc-history', userId] as const,
  customerAccounts: (userId: string) => ['accounts', 'customer', userId] as const,
  alerts: (status?: string, offset = 0) => ['fraud', 'alerts', status ?? 'all', offset] as const,
  alertsAll: ['fraud', 'alerts'] as const,
  alertHistory: (id: string) => ['fraud', 'history', id] as const,
  adminRequests: (status?: string, offset = 0) => ['admin', 'requests', status ?? 'all', offset] as const,
  adminRequestsAll: ['admin', 'requests'] as const,
  directory: (params: object) => ['admin', 'users', params] as const,
  directoryAll: ['admin', 'users'] as const,
  notificationLogs: (params: object) => ['notifications', params] as const,
  /** Everything about the customer's own top-ups: config (today's usage), lists and single top-ups */
  payments: ['payments'] as const,
  paymentsConfig: ['payments', 'config'] as const,
  topUps: ['payments', 'top-ups'] as const,
  topUp: (id: string) => ['payments', 'top-up', id] as const,
  assistantMeta: ['assistant', 'meta'] as const,
  conversations: ['assistant', 'conversations'] as const,
  conversation: (id: string) => ['assistant', 'conversation', id] as const,
  deviceSessions: ['security', 'sessions'] as const,
  securityEvents: ['security', 'events'] as const,
};
