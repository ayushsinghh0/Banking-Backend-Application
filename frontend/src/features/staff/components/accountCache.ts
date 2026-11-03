import type { QueryClient } from '@tanstack/react-query';
import type { BankAccount } from '@/lib/api/types';
import { qk } from '@/lib/query';

/**
 * Puts the account the API returned after a change into the customer's account list (the response is the
 * authoritative new state) and marks the single-account view stale.
 */
export function applyAccountUpdate(queryClient: QueryClient, customerId: string, updated: BankAccount): void {
  queryClient.setQueryData<BankAccount[]>(qk.customerAccounts(customerId), (list) =>
    list?.map((account) => (account.id === updated.id ? { ...account, ...updated } : account))
  );
  queryClient.setQueryData(qk.account(updated.id), updated);
}
