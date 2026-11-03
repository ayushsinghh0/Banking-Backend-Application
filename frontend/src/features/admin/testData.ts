import { http } from 'msw';
import { aDirectoryUser, IDS } from '@/test/fixtures';
import { apiUrl, ok } from '@/test/render';
import type { DirectoryUser } from '@/lib/api/types';

/** Test-only data for the administration pages */

export const ME = { id: IDS.admin, email: 'priya.nair@banksphere.local' } as const;

/** Signed in as the first administrator */
export const asAdmin = { role: 'BANK_ADMIN' as const, claims: { sub: ME.id, email: ME.email } };
export const asSupport = { role: 'SUPPORT' as const, claims: { sub: 'support-1', email: 'sam.support@banksphere.local' } };

export const PEOPLE: DirectoryUser[] = [
  aDirectoryUser({ id: IDS.admin, email: ME.email, role: 'BANK_ADMIN' }),
  aDirectoryUser({ id: IDS.admin2, email: 'rahul.admin@banksphere.local', role: 'BANK_ADMIN' }),
  aDirectoryUser({ id: IDS.teller, email: 'meera.teller@banksphere.local', role: 'TELLER' }),
  aDirectoryUser({ id: IDS.customer, email: 'asha@example.in', role: 'CUSTOMER', mfaEnabled: false }),
];

/** ISO timestamp relative to now, so relative-time copy is deterministic */
export const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
export const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

/** GET /auth/admin/users that resolves ids (q=<uuid>) and email fragments against PEOPLE */
export function directoryLookupHandler(people: DirectoryUser[] = PEOPLE, seen?: string[]) {
  return http.get(apiUrl('/auth/admin/users'), ({ request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? '';
    seen?.push(q);
    return ok(people.filter((p) => !q || p.id === q || p.email.includes(q.toLowerCase())));
  });
}
