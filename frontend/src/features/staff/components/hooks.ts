import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isApiError } from '@/lib/api/errors';

/** The value, once it has stopped changing for `delayMs` (search boxes) */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export const isNotFound = (error: unknown) => isApiError(error) && error.status === 404;

export const hasCode = (error: unknown, ...codes: string[]) => isApiError(error) && codes.includes(error.code);

/**
 * The API answered and said no (validation, permission, missing, conflict): show why and stop. Anything else
 * (offline, timeout, 5xx) is transient, and the person may simply try the same action again.
 */
export const isRefusal = (error: unknown) => isApiError(error) && [400, 403, 404, 409, 422].includes(error.status);

/** The API caps offsets at 10,000 */
const MAX_OFFSET = 10_000;

type ParamValue = string | number | undefined | null;

/**
 * List state (tab, filters, page) kept in the address, so going back from a record restores the exact
 * view and a link to a filtered list can be shared with a colleague.
 */
export function useListParams() {
  const [params, setParams] = useSearchParams();
  const update = useCallback(
    (changes: Record<string, ParamValue>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined || value === null || value === '' || (key === 'offset' && value === 0)) next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  const raw = Number.parseInt(params.get('offset') ?? '', 10);
  const offset = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_OFFSET) : 0;
  return { params, update, offset };
}

/** A search box whose settled value (trimmed) is written to `?q=` and resets paging */
export function useSearchParam(params: URLSearchParams, update: (changes: Record<string, ParamValue>) => void, delayMs = 300) {
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const settled = useDebouncedValue(search.trim(), delayMs);
  const last = useRef(settled);
  useEffect(() => {
    if (last.current === settled) return;
    last.current = settled;
    update({ q: settled, offset: undefined });
  }, [settled, update]);
  return { search, setSearch, q };
}
