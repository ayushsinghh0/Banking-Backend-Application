import { useEffect, useRef, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useRealtimeStatus } from '@/lib/realtime';

/** Brief drops (a deploy, a network hand-over) reconnect on their own: only say something if one lasts */
const GRACE_MS = 4_000;

/**
 * A quiet note that live updates have stopped. Nothing is shown while the connection is healthy or
 * reconnecting quickly; pages keep working either way (they refetch on focus and after every action).
 */
export function ConnectionIndicator({ className, graceMs = GRACE_MS }: { className?: string; graceMs?: number }) {
  const status = useRealtimeStatus();
  const [visible, setVisible] = useState(false);
  const since = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (status === 'open') {
      since.current = null;
      clearTimeout(timer.current);
      timer.current = undefined;
      setVisible(false);
      return;
    }
    since.current ??= Date.now();
    if (status === 'offline' && timer.current === undefined) {
      timer.current = setTimeout(() => setVisible(true), Math.max(0, graceMs - (Date.now() - since.current)));
    }
  }, [status, graceMs]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!visible) return null;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const text = online ? 'Live updates paused' : 'You’re offline';
  return (
    <span
      role="status"
      title={online ? 'Reconnecting. Balances and activity still update when you refresh or act.' : 'Check your connection.'}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-[12.5px] font-medium text-muted-foreground animate-fade-in',
        className
      )}
    >
      <CloudOff className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{text}</span>
    </span>
  );
}
