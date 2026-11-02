import { useEffect, useRef, useState } from 'react';
import { UUID_PATTERN } from '@/lib/validation';
import { useDebouncedValue } from '@/features/staff/components/hooks';

/**
 * A filter box for an ID kept in the address: what is typed applies once it has settled into a whole ID (a
 * partial one would match nothing), and a change made elsewhere (clear filters, the back button) shows up in
 * the box. Only typing applies, so a stale box can never write an old value back.
 */
export function useIdFilter(applied: string, onApply: (id: string | undefined) => void, delayMs = 300) {
  const [text, setText] = useState(applied);
  const settled = useDebouncedValue(text.trim(), delayMs);
  const valid = settled === '' || UUID_PATTERN.test(settled);
  const lastSettled = useRef(settled);
  const lastApplied = useRef(applied);

  useEffect(() => {
    if (applied === lastApplied.current) return;
    lastApplied.current = applied;
    setText((current) => (current.trim().toLowerCase() === applied.toLowerCase() ? current : applied));
  }, [applied]);

  useEffect(() => {
    if (settled === lastSettled.current) return;
    lastSettled.current = settled;
    if (valid && settled.toLowerCase() !== applied.toLowerCase()) onApply(settled.toLowerCase() || undefined);
  }, [settled, valid, applied, onApply]);

  return { text, setText, invalid: !valid };
}
