import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { RealtimeConnection, type RealtimeEnvelope, type RealtimeStatus } from './connection';
import { RealtimeDefaults } from './defaults';

type Handler = (data: unknown, event: RealtimeEnvelope) => void;

interface RealtimeContextValue {
  status: RealtimeStatus;
  subscribe: (type: string, handler: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** A tab hidden this long stops holding a stream open; it resumes (and catches up) when shown again */
const HIDDEN_PAUSE_MS = 5 * 60_000;

/**
 * Keeps one real-time stream open for the signed-in person (`GET /api/v1/realtime/stream`, read with fetch so
 * it carries the bearer token) and fans its events out to `useRealtimeEvent` subscribers. Mounted by the
 * authenticated shell, inside the router. It also applies the app-wide reactions (query invalidation and the
 * money-in toasts) so individual pages only add what is specific to them.
 */
export function RealtimeProvider({ children, hiddenPauseMs = HIDDEN_PAUSE_MS }: { children: ReactNode; hiddenPauseMs?: number }) {
  const { client, status: authStatus, user, refreshAccessToken } = useAuth();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const listeners = useRef(new Map<string, Set<Handler>>());
  // The auth context is rebuilt on every token change; the stream must not reconnect because of it
  const refresh = useRef(refreshAccessToken);
  refresh.current = refreshAccessToken;
  const userId = authStatus === 'authenticated' ? user?.id : undefined;

  const subscribe = useCallback((type: string, handler: Handler) => {
    const set = listeners.current.get(type) ?? new Set<Handler>();
    listeners.current.set(type, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (!userId) {
      setStatus('offline');
      return;
    }
    const connection = new RealtimeConnection({
      open: ({ signal, lastEventId }) =>
        client.stream('/realtime/stream', { signal, headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined }),
      refreshAccessToken: () => refresh.current(),
      onStatus: setStatus,
      onEvent: (event) => {
        for (const handler of [...(listeners.current.get(event.type) ?? [])]) {
          try {
            handler(event.data, event);
          } catch (error) {
            // One broken subscriber must not starve the others
            console.error(`Real-time handler for "${event.type}" failed`, error);
          }
        }
      },
    });
    connection.start();

    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === 'hidden') hiddenTimer = setTimeout(() => connection.pause(), hiddenPauseMs);
      else connection.resume();
    };
    const onOnline = () => connection.retryNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    if (document.visibilityState === 'hidden') onVisibility();
    return () => {
      clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      connection.stop();
    };
  }, [client, userId, hiddenPauseMs]);

  const value = useMemo(() => ({ status, subscribe }), [status, subscribe]);
  return (
    <RealtimeContext.Provider value={value}>
      <RealtimeDefaults />
      {children}
    </RealtimeContext.Provider>
  );
}

/**
 * Calls `handler` with the data of every real-time event of `type` while the component is mounted. The
 * handler can change between renders without resubscribing. Outside a RealtimeProvider it does nothing.
 */
export function useRealtimeEvent<T>(type: string, handler: (data: T) => void): void {
  const context = useContext(RealtimeContext);
  const latest = useRef(handler);
  latest.current = handler;
  const subscribe = context?.subscribe;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe(type, (data) => latest.current(data as T));
  }, [subscribe, type]);
}

/** 'open' while events are flowing; 'offline' outside a provider or while disconnected */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext)?.status ?? 'offline';
}
