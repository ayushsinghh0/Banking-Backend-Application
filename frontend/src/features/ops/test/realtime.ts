import { useEffect, useRef, type ReactNode } from 'react';
import { act } from '@testing-library/react';

/**
 * A stand-in for `@/lib/realtime` in page tests: no stream, just a way to deliver an event as if it had
 * arrived. Use with
 *
 *   vi.mock('@/lib/realtime', async () => (await import('@/features/ops/test/realtime')).realtimeModule);
 */
type Handler = (data: unknown) => void;

const listeners = new Map<string, Set<{ current: Handler }>>();

function useRealtimeEvent<T>(type: string, handler: (data: T) => void): void {
  const latest = useRef(handler as Handler);
  latest.current = handler as Handler;
  useEffect(() => {
    const set = listeners.get(type) ?? new Set();
    listeners.set(type, set);
    set.add(latest);
    return () => {
      set.delete(latest);
    };
  }, [type]);
}

export const realtimeModule = {
  RealtimeProvider: ({ children }: { children: ReactNode }) => children,
  useRealtimeEvent,
  useRealtimeStatus: () => 'open' as const,
};

/** Delivers a real-time event to every mounted subscriber */
export function emitRealtime(type: string, data: unknown): void {
  act(() => {
    for (const subscriber of listeners.get(type) ?? []) subscriber.current(data);
  });
}

/** How many components are listening for an event type */
export const subscriberCount = (type: string) => listeners.get(type)?.size ?? 0;
