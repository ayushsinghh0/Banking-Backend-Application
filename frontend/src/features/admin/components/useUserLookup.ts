import { useQueries } from '@tanstack/react-query';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { DirectoryUser } from '@/lib/api/types';

export type PersonResolution =
  | { kind: 'me' }
  | { kind: 'loading' }
  | { kind: 'user'; user: DirectoryUser }
  | { kind: 'unknown'; id: string };

export type ResolvePerson = (id: string | null | undefined) => PersonResolution | null;

/**
 * Resolves user ids (requesters, approvers, targets, tellers) to directory entries. Each id is one cached
 * directory search (q=<id>) shared by every screen, so a person is fetched once however often they appear.
 * The signed-in user is never looked up: they are "you".
 */
export function useUserLookup(ids: ReadonlyArray<string | null | undefined>): ResolvePerson {
  const api = useApi();
  const me = useUser();
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id) && id !== me.id))].sort();

  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: qk.directory({ lookup: id }),
      queryFn: async () => (await api.admin.users({ q: id, limit: 5 })).find((user) => user.id === id) ?? null,
      staleTime: 5 * 60_000,
    })),
  });

  const byId = new Map<string, PersonResolution>();
  unique.forEach((id, index) => {
    const result = results[index];
    if (!result || result.isPending) byId.set(id, { kind: 'loading' });
    else if (result.data) byId.set(id, { kind: 'user', user: result.data });
    else byId.set(id, { kind: 'unknown', id });
  });

  return (id) => {
    if (!id) return null;
    if (id === me.id) return { kind: 'me' };
    return byId.get(id) ?? { kind: 'unknown', id };
  };
}

/** Plain-text name for dialog copy and toasts */
export function personText(person: PersonResolution | null, fallback: string, me = 'your account'): string {
  if (person?.kind === 'me') return me;
  if (person?.kind === 'user') return person.user.email;
  return fallback;
}
