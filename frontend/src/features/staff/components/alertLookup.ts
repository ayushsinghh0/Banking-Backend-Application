import type { QueryClient } from '@tanstack/react-query';
import type { Endpoints } from '@/lib/api/endpoints';
import type { AlertStatus, FraudAlert } from '@/lib/api/types';
import { qk } from '@/lib/query';

/** The API has no single-alert endpoint: look through the newest alerts, a bounded number of pages */
export const SCAN_PAGE_SIZE = 100;
export const SCAN_MAX_PAGES = 5;

/** Lives under qk.alertsAll so anything that refreshes the alert lists also refreshes an open alert */
export const alertKey = (alertId: string) => [...qk.alertsAll, 'find', alertId] as const;

async function scan(api: Endpoints, alertId: string, status?: AlertStatus): Promise<FraudAlert | null> {
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const rows = await api.fraud.alerts({ status, limit: SCAN_PAGE_SIZE, offset: page * SCAN_PAGE_SIZE });
    const match = rows.find((alert) => alert.id === alertId);
    if (match) return match;
    if (rows.length < SCAN_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * Finds an alert by id. With a hint (the status it had when last seen) that status is searched first, which
 * is almost always a single request; then the newest alerts of every status.
 */
export async function findAlert(api: Endpoints, alertId: string, hint?: AlertStatus): Promise<FraudAlert | null> {
  if (hint) {
    const hit = await scan(api, alertId, hint);
    if (hit) return hit;
  }
  return scan(api, alertId);
}

/** Stores the alert the API returned after a change and refreshes the lists and the history */
export function applyAlertUpdate(queryClient: QueryClient, updated: FraudAlert): void {
  queryClient.setQueryData(alertKey(updated.id), updated);
  void queryClient.invalidateQueries({ queryKey: qk.alertsAll, predicate: (query) => query.queryKey[2] !== 'find' });
  void queryClient.invalidateQueries({ queryKey: qk.alertHistory(updated.id) });
}
