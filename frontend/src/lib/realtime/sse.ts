/**
 * A small server-sent events parser that follows the WHATWG event-stream rules. EventSource can't send an
 * Authorization header, so the app reads event streams through fetch and parses them here: the real-time
 * stream (GET) and Sphere's answers (POST) both use it.
 */

export interface SseEvent {
  /** The `event:` field, or "message" */
  type: string;
  data: string;
  /** The last event id at the time of dispatch (ids carry over to later events until changed) */
  id: string;
}

export interface SseHandlers {
  onEvent: (event: SseEvent) => void;
  /** Lines starting with ":" (servers send them as heartbeats) */
  onComment?: (text: string) => void;
  /** A `retry:` field: the reconnection delay the server asks for, in milliseconds */
  onRetry?: (ms: number) => void;
}

const LF = 10;
const CR = 13;

export class SseParser {
  private pending = '';
  private data = '';
  private eventType = '';
  private idBuffer = '';
  private dispatchedId = '';
  /** The previous chunk ended with CR, so a LF at the start of the next one belongs to it */
  private trailingCR = false;
  private started = false;

  constructor(private readonly handlers: SseHandlers) {}

  /** The id to send as Last-Event-ID when reconnecting */
  get lastEventId(): string {
    return this.dispatchedId;
  }

  feed(chunk: string): void {
    let text = this.pending + chunk;
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    if (this.trailingCR && this.pending === '' && text.charCodeAt(0) === LF) start = 1;
    this.trailingCR = false;
    for (let i = start; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code !== LF && code !== CR) continue;
      this.line(text.slice(start, i));
      if (code === CR) {
        if (i + 1 === text.length) this.trailingCR = true;
        else if (text.charCodeAt(i + 1) === LF) i += 1;
      }
      start = i + 1;
    }
    this.pending = text.slice(start);
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) {
      this.handlers.onComment?.(line.slice(1).replace(/^ /, ''));
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* space */) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data += `${value}\n`;
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.idBuffer = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value));
        break;
      default:
        // Unknown fields are ignored, as the standard requires
        break;
    }
  }

  private dispatch(): void {
    this.dispatchedId = this.idBuffer;
    if (this.data === '') {
      this.eventType = '';
      return;
    }
    const event: SseEvent = { type: this.eventType || 'message', data: this.data.slice(0, -1), id: this.dispatchedId };
    this.data = '';
    this.eventType = '';
    this.handlers.onEvent(event);
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The stream was aborted', 'AbortError');
}

/**
 * Reads a response body as an event stream until the server ends it. Resolves when the stream ends; rejects
 * with an AbortError if `signal` aborts (the body is cancelled, so the connection closes), or with the
 * network error that broke the stream.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: SseHandlers & { /** Any bytes arrived (for stall detection) */ onActivity?: () => void },
  signal?: AbortSignal
): Promise<SseParser> {
  const parser = new SseParser(handlers);
  if (signal?.aborted) {
    await body.cancel().catch(() => undefined);
    throw abortError(signal);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (done) break;
      handlers.onActivity?.();
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    return parser;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
