import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { RealtimeConnection, backoffDelay, type RealtimeEnvelope, type RealtimeStatus } from './connection';

/** A fetch response whose event stream the test writes to */
function fakeStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    send: (type: string, data: unknown, id?: string) =>
      controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
    get cancelled() {
      return cancelled;
    },
  };
}

type Stream = ReturnType<typeof fakeStream>;

function setup(options: { random?: () => number; stallTimeoutMs?: number } = {}) {
  const streams: Stream[] = [];
  const opens: Array<{ lastEventId: string | null; at: number }> = [];
  const failures: unknown[] = [];
  const events: RealtimeEnvelope[] = [];
  const statuses: RealtimeStatus[] = [];
  const refreshAccessToken = vi.fn(async () => 'fresh-token');
  const open = vi.fn(async ({ lastEventId }: { signal: AbortSignal; lastEventId: string | null }) => {
    opens.push({ lastEventId, at: Date.now() });
    const failure = failures.shift();
    if (failure) throw failure;
    const stream = fakeStream();
    streams.push(stream);
    return stream.response;
  });
  const connection = new RealtimeConnection({
    open,
    refreshAccessToken,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    random: options.random ?? (() => 0.5),
    stallTimeoutMs: options.stallTimeoutMs,
  });
  return { connection, open, opens, streams, failures, events, statuses, refreshAccessToken, latest: () => streams[streams.length - 1]! };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelay', () => {
  it('doubles from the base, keeps at least half of the step, and never passes the cap', () => {
    const at = (attempt: number, r: number) => backoffDelay(attempt, { baseMs: 1000, maxMs: 30_000, random: () => r });
    expect([1, 2, 3, 4].map((n) => at(n, 0))).toEqual([500, 1000, 2000, 4000]);
    expect([1, 2, 3, 4].map((n) => at(n, 1))).toEqual([1000, 2000, 4000, 8000]);
    expect(at(12, 1)).toBe(30_000);
    expect(at(12, 0)).toBe(15_000);
    expect(at(0, 1)).toBe(1000);
  });
});

describe('RealtimeConnection', () => {
  it('opens the stream, reports open, and delivers events without the internal ones', async () => {
    const t = setup();
    t.connection.start();
    expect(t.statuses).toEqual(['connecting']);
    await settle();
    expect(t.statuses).toEqual(['connecting', 'open']);
    t.latest().send('ready', { connectionId: 'c1', heartbeatSeconds: 20 });
    // The documented envelope: { id, type, at, data }
    t.latest().send('payment.updated', { id: '9', type: 'payment.updated', at: '2026-10-28T10:00:00Z', data: { topUpId: 't1', status: 'CREDITED' } }, '9');
    // A bare payload is accepted too
    t.latest().send('payee.added', { beneficiaryId: 'b1' });
    await settle();
    expect(t.events).toEqual([
      { id: '9', type: 'payment.updated', at: '2026-10-28T10:00:00Z', data: { topUpId: 't1', status: 'CREDITED' } },
      { id: '9', type: 'payee.added', at: null, data: { beneficiaryId: 'b1' } },
    ]);
    t.connection.stop();
  });

  it('reconnects after failures with growing, jittered, capped delays and says it is offline meanwhile', async () => {
    const t = setup();
    t.failures.push(
      new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'down' }),
      new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'down' }),
      new ApiError({ status: 502, code: 'BAD_GATEWAY', message: 'down' })
    );
    t.connection.start();
    await settle();
    expect(t.statuses.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(749);
    expect(t.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 750 ms: 0.75 of the first 1 s step
    expect(t.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.open).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.open).toHaveBeenCalledTimes(4);
    expect(t.statuses.at(-1)).toBe('open');
    t.connection.stop();
  });

  it('asks for missed events with Last-Event-ID after a drop, and ignores replayed duplicates', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    const posted = (id: string) => ({ id, type: 'transaction.posted', at: '2026-10-28T10:00:00Z', data: { transactionId: `x${id}` } });
    t.latest().send('transaction.posted', posted('41'), '41');
    t.latest().send('transaction.posted', posted('42'), '42');
    await settle();
    t.latest().end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.opens.map((o) => o.lastEventId)).toEqual([null, '42']);
    t.latest().send('transaction.posted', posted('42'), '42');
    t.latest().send('transaction.posted', posted('43'), '43');
    await settle();
    expect(t.events.map((e) => e.id)).toEqual(['41', '42', '43']);
    t.connection.stop();
  });

  it('waits at least as long as Retry-After when the server has too many streams', async () => {
    const t = setup();
    t.failures.push(new ApiError({ status: 429, code: 'TOO_MANY_STREAMS', message: 'busy', retryAfterSeconds: 20 }));
    t.connection.start();
    await settle();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(t.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('renews the token on reauth and reconnects straight away', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.latest().send('reauth', {});
    await settle();
    expect(t.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(t.open).toHaveBeenCalledTimes(2);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.statuses.at(-1)).toBe('open');
    expect(t.statuses).not.toContain('offline');
    t.connection.stop();
  });

  it('reconnects quickly after a healthy stream ends, using the server retry delay', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.latest().push('retry: 2000\n\n');
    await vi.advanceTimersByTimeAsync(30_000);
    t.latest().push(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(30_000);
    t.latest().push(': heartbeat\n\n');
    t.latest().end();
    await settle();
    expect(t.statuses.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1499);
    expect(t.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('backs off when streams keep ending as soon as they open', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.latest().end();
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.latest().end();
    await settle();
    await vi.advanceTimersByTimeAsync(1499);
    expect(t.open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.open).toHaveBeenCalledTimes(3);
    t.connection.stop();
  });

  it('drops a stream that goes quiet past the heartbeat allowance and opens a new one', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.latest().send('ready', { connectionId: 'c1', heartbeatSeconds: 2 });
    await vi.advanceTimersByTimeAsync(4_000);
    t.latest().push(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(t.streams[0]!.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('closes on stop and never reconnects', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.connection.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)).toBe('offline');
  });

  it('pauses without reconnecting and resumes from the last event', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.latest().send('account.status', { accountId: 'a1', status: 'FROZEN' }, '7');
    await settle();
    t.connection.pause();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)).toBe('offline');
    t.connection.resume();
    await settle();
    expect(t.opens.map((o) => o.lastEventId)).toEqual([null, '7']);
    expect(t.statuses.at(-1)).toBe('open');
    t.connection.stop();
  });

  it('gives up when the session has ended', async () => {
    const t = setup();
    t.failures.push(new ApiError({ status: 401, code: 'UNAUTHORIZED', message: 'signed out' }));
    t.connection.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)).toBe('offline');
  });

  it('waits the longest delay when the stream is not available here', async () => {
    const t = setup();
    t.failures.push(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'no' }));
    t.connection.start();
    await settle();
    await vi.advanceTimersByTimeAsync(22_499);
    expect(t.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('treats a response that is not an event stream as a failure', async () => {
    const t = setup();
    t.open.mockImplementationOnce(async () => new Response('{"success":true}', { headers: { 'Content-Type': 'application/json' } }));
    t.connection.start();
    await settle();
    expect(t.statuses.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(750);
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('skips the wait when asked to retry now', async () => {
    const t = setup();
    t.failures.push(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline' }));
    t.connection.start();
    await settle();
    t.connection.retryNow();
    await settle();
    expect(t.open).toHaveBeenCalledTimes(2);
    expect(t.statuses.at(-1)).toBe('open');
    // Nothing to do while connected
    t.connection.retryNow();
    await settle();
    expect(t.open).toHaveBeenCalledTimes(2);
    t.connection.stop();
  });

  it('ignores a second start and a stray resume', async () => {
    const t = setup();
    t.connection.resume();
    t.connection.start();
    t.connection.start();
    await settle();
    expect(t.open).toHaveBeenCalledTimes(1);
    t.connection.stop();
  });
});
