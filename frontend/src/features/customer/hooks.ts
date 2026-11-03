import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { isApiError } from '@/lib/api/errors';
import { qk } from '@/lib/query';

/**
 * The signed-in customer's profile. A 404 is not an error here: it means the customer has not created a
 * profile yet, so the query resolves to null and pages show onboarding instead.
 */
export function useProfile() {
  const api = useApi();
  return useQuery({
    queryKey: qk.profile,
    queryFn: async () => {
      try {
        return await api.customers.me();
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function useAccounts() {
  const api = useApi();
  return useQuery({ queryKey: qk.accounts, queryFn: () => api.accounts.list() });
}

export function useBalance(accountId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.balance(accountId ?? ''),
    queryFn: () => api.ledger.balance(accountId ?? ''),
    enabled: Boolean(accountId),
  });
}

/** One balance query per account, keyed so a single invalidation of `qk.balances` refreshes them all */
export function useBalances(accountIds: string[]) {
  const api = useApi();
  return useQueries({
    queries: accountIds.map((id) => ({ queryKey: qk.balance(id), queryFn: () => api.ledger.balance(id) })),
  });
}

export function useBeneficiaries() {
  const api = useApi();
  return useQuery({ queryKey: qk.beneficiaries, queryFn: () => api.ledger.beneficiaries() });
}

/** The current time, re-read every `intervalMs` (for countdowns); pauses when `enabled` is false */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/** Width of an element, kept up to date with a ResizeObserver (0 until it has been laid out) */
export function useElementWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.current.observe(node);
  }, []);
  return [ref, width] as const;
}
