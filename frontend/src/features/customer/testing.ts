/**
 * Test-only helpers for the customer pages: registers the read endpoints a page needs with MSW.
 * Not imported by application code.
 */
import { afterEach } from 'vitest';
import { http, type HttpHandler } from 'msw';
import { toast } from 'sonner';
import type { BankAccount, Beneficiary, CustomerProfile, LedgerEntry } from '@/lib/api/types';
import { server } from '@/test/server';
import { apiUrl, fail, ok } from '@/test/render';
import { aBalance } from '@/test/fixtures';

// Sonner keeps toasts in a module-level store and replays the active ones to every new <Toaster>, so a toast
// from one test would otherwise reappear in the next. Importing this module clears them after each test.
afterEach(() => {
  toast.dismiss();
});

export interface CustomerApiMock {
  /** null answers 404 (no profile yet) */
  profile?: CustomerProfile | null;
  accounts?: BankAccount[];
  /** accountId -> balance in paise */
  balances?: Record<string, string>;
  /** accountId -> entries, newest first (served with offset/limit like the API) */
  history?: Record<string, LedgerEntry[]>;
  beneficiaries?: Beneficiary[];
}

export function mockCustomerApi(mock: CustomerApiMock): void {
  const handlers: HttpHandler[] = [];
  if (mock.profile !== undefined) {
    const profile = mock.profile;
    handlers.push(
      http.get(apiUrl('/customers/me'), () => (profile ? ok(profile) : fail(404, 'NOT_FOUND', 'Customer profile not found')))
    );
  }
  if (mock.accounts) {
    const accounts = mock.accounts;
    handlers.push(
      http.get(apiUrl('/accounts'), () => ok(accounts)),
      http.get(apiUrl('/accounts/:accountId'), ({ params }) => {
        const account = accounts.find((a) => a.id === params.accountId);
        return account ? ok(account) : fail(404, 'NOT_FOUND', 'Bank account not found');
      })
    );
  }
  if (mock.balances) {
    const balances = mock.balances;
    handlers.push(
      http.get(apiUrl('/transactions/accounts/:accountId/balance'), ({ params }) => {
        const id = String(params.accountId);
        return ok(aBalance(id, balances[id] ?? '0'));
      })
    );
  }
  if (mock.history) {
    const history = mock.history;
    handlers.push(
      http.get(apiUrl('/transactions/accounts/:accountId/history'), ({ params, request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 20);
        return ok((history[String(params.accountId)] ?? []).slice(offset, offset + limit));
      })
    );
  }
  if (mock.beneficiaries) {
    const beneficiaries = mock.beneficiaries;
    handlers.push(http.get(apiUrl('/transactions/beneficiaries'), () => ok(beneficiaries)));
  }
  server.use(...handlers);
}

/** An ISO timestamp `minutes` from now (negative for the past) */
export const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** An ISO timestamp `days` before now */
export const daysAgo = (days: number, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
