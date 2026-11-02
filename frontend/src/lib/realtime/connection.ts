import { isApiError } from '@/lib/api/errors';
import { readEventStream, type SseEvent } from './sse';

export type RealtimeStatus = 'connecting' | 'open' | 'offline';

/** One real-time event. Events are hints: pages refetch the truth from the APIs. */
export interface RealtimeEnvelope<T = unknown> {
  id: string;
  type: string;
  at: string | null;
  data: T;
}

export interface RealtimeConnectionOptions {
  /** Opens the stream with the current access token; rejects with an ApiError for HTTP errors */
  open: (init: { signal: AbortSignal; lastEventId: string | null }) => Promise<Response>;
  /** Renews the access token when the server asks for it (`reauth`) */
  refreshAccessToken: () => Promise<string | null>;
  onEvent: (event: RealtimeEnvelope) => void;
  onStatus: (status: RealtimeStatus) => void;
  /** First reconnect delay (default 1 s); a `retry:` field from the server replaces it */
  baseDelayMs?: number;
  /** Longest reconnect delay (default 30 s) */
  maxDelayMs?: number;
  /** Drop and reopen a stream that has been silent this long (default 45 s; `ready` refines it from the heartbeat) */
  stallTimeoutMs?: number;
  random?: () => number;
}

/** A stream that lasted at least this long was healthy: its end is routine, not a failure */
const HEALTHY_STREAM_MS = 5_000;
/** Allowance before a silent stream counts as dead, as a multiple of the server's heartbeat */
const HEARTBEAT_ALLOWANCE = 2.5;
/** Replayed events (Last-Event-ID) can overlap what was already delivered; remember this many ids */
const SEEN_IDS = 200;
/** Far beyond any cap: makes the next delay the longest one */
const LONGEST = 64;

/**
 * Capped exponential backoff with jitter: the step doubles from `baseMs` up to `maxMs`, and the delay is a
 * random point in the upper half of the step, so a fleet of clients that dropped together comes back spread
 * out (and never instantly).
 */
export function backoffDelay(attempt: number, { baseMs, maxMs, random }: { baseMs: number; maxMs: number; random: () => number }): number {
  const step = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, LONGEST) - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The service sends `{ id, type, at, data }` in the data field. A bare payload (no envelope) is accepted too,
 * typed by the SSE event name.
 */
function toEnvelope(frame: SseEvent): { event: RealtimeEnvelope; envelopeId: string | null } {
  let parsed: unknown = frame.data;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    // Not JSON: deliver the text as it is
  }
  if (isObject(parsed) && typeof parsed.type === 'string' && 'data' in parsed && (frame.type === 'message' || frame.type === parsed.type)) {
    const envelopeId = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : null;
    return {
      event: { id: frame.id || envelopeId || '', type: parsed.type, at: typeof parsed.at === 'string' ? parsed.at : null, data: parsed.data },
      envelopeId,
    };
  }
  return { event: { id: frame.id, type: frame.type, at: null, data: parsed }, envelopeId: null };
}

const isEventStream = (response: Response) => (response.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/event-stream');

/**
 * One real-time stream with everything a long-lived connection needs: reconnects with capped exponential
 * backoff and jitter, resumes with Last-Event-ID, renews the token when the server says `reauth`, drops a
 * stream that has gone silent, and can be paused (hidden tab) and stopped (sign-out). Framework-free, so it
 * is tested on its own; RealtimeProvider wires it to React.
 */
export class RealtimeConnection {
  private status: RealtimeStatus | null = null;
  private running = false;
  private paused = false;
  /** Bumped whenever the current attempt is abandoned on purpose (stop, pause, retry now) */
  private generation = 0;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastEventId: string | null = null;
  private serverRetryMs: number | null = null;
  private stallMs: number;
  private readonly seen: string[] = [];
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;

  constructor(private readonly options: RealtimeConnectionOptions) {
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.stallMs = options.stallTimeoutMs ?? 45_000;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    void this.connect();
  }

  /** Closes the stream for good (sign-out, unmount) */
  stop(): void {
    this.running = false;
    this.paused = false;
    this.abandon();
    this.setStatus('offline');
  }

  /** Closes the stream until `resume` (e.g. the tab has been hidden for a long time) */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.abandon();
    this.setStatus('offline');
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.attempt = 0;
    void this.connect();
  }

  /** Skips a pending reconnect delay (e.g. the device is back online) */
  retryNow(): void {
    if (!this.running || this.paused || this.retryTimer === null) return;
    this.attempt = 0;
    this.abandon();
    void this.connect();
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private abandon(): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearStall();
    this.controller?.abort();
    this.controller = null;
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private armStall(controller: AbortController): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => controller.abort(new Error('The real-time stream went silent')), this.stallMs);
  }

  private remember(id: string): boolean {
    if (this.seen.includes(id)) return false;
    this.seen.push(id);
    if (this.seen.length > SEEN_IDS) this.seen.shift();
    return true;
  }

  private schedule(delayMs: number, status: RealtimeStatus): void {
    this.setStatus(status);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delayMs);
  }

  private nextDelay(): number {
    return backoffDelay(this.attempt, { baseMs: this.serverRetryMs ?? this.baseDelayMs, maxMs: this.maxDelayMs, random: this.random });
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('connecting');
    let openedAt: number | null = null;
    let reauth = false;

    try {
      const response = await this.options.open({ signal: controller.signal, lastEventId: this.lastEventId });
      if (generation !== this.generation) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.body || !isEventStream(response)) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('The real-time endpoint did not answer with an event stream');
      }
      openedAt = Date.now();
      this.setStatus('open');
      this.armStall(controller);
      await readEventStream(
        response.body,
        {
          onActivity: () => this.armStall(controller),
          onRetry: (ms) => {
            this.serverRetryMs = ms;
          },
          onEvent: (frame) => {
            if (frame.id) this.lastEventId = frame.id;
            const { event, envelopeId } = toEnvelope(frame);
            if (event.type === 'ready') {
              const heartbeat = isObject(event.data) ? Number(event.data.heartbeatSeconds) : NaN;
              if (Number.isFinite(heartbeat) && heartbeat > 0) this.stallMs = heartbeat * HEARTBEAT_ALLOWANCE * 1000;
              this.armStall(controller);
              return;
            }
            if (event.type === 'reauth') {
              // The access token is about to expire: the server closes the stream, so reconnect with a new one
              reauth = true;
              controller.abort();
              return;
            }
            if (envelopeId !== null && !this.remember(envelopeId)) return;
            this.options.onEvent(event);
          },
        },
        controller.signal
      );
    } catch (error) {
      if (generation !== this.generation || !this.running) return;
      if (!reauth) {
        this.clearStall();
        this.onFailure(error, openedAt);
        return;
      }
    }

    if (generation !== this.generation || !this.running) return;
    this.clearStall();
    if (reauth) {
      try {
        await this.options.refreshAccessToken();
      } catch {
        // A transient refresh failure: the next attempt renews on its 401, or backs off
      }
      if (generation !== this.generation || !this.running) return;
      this.attempt = 0;
      void this.connect();
      return;
    }
    // The server ended the stream. Routine after a healthy connection; a stream that ends as soon as it
    // opens is treated like a failure, so a misbehaving server is never hammered.
    const healthy = openedAt !== null && Date.now() - openedAt >= HEALTHY_STREAM_MS;
    this.attempt = healthy ? 1 : this.attempt + 1;
    this.schedule(this.nextDelay(), healthy ? 'connecting' : 'offline');
  }

  private onFailure(error: unknown, openedAt: number | null): void {
    // A stream that broke after a healthy run starts the backoff afresh
    if (openedAt !== null && Date.now() - openedAt >= HEALTHY_STREAM_MS) this.attempt = 0;
    if (isApiError(error) && error.status === 401) {
      // The session could not be renewed: it is over, and the app is signing out
      this.running = false;
      this.setStatus('offline');
      return;
    }
    // Not available to this user or deployment: try again rarely
    this.attempt = isApiError(error) && (error.status === 403 || error.status === 404) ? LONGEST : this.attempt + 1;
    let delay = this.nextDelay();
    if (isApiError(error) && error.retryAfterSeconds) delay = Math.max(delay, error.retryAfterSeconds * 1000);
    this.schedule(delay, 'offline');
  }
}
