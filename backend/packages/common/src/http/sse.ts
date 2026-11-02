import { Request, Response } from 'express';

/**
 * Server-Sent Events over a plain HTTP response (used by real-time updates and the assistant's streamed
 * answers). Each event is one `data:` line of JSON, so payloads can never inject extra fields or events; ids
 * and event names are restricted to safe characters. A comment heartbeat keeps proxies and load balancers
 * from closing an idle stream, and everything stops when the client disconnects.
 */
export interface EventStream {
  /** False once the stream is closed (the event was not sent) */
  send(event: string, data: unknown, id?: string): boolean;
  comment(text: string): void;
  close(): void;
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

export interface EventStreamOptions {
  heartbeatMs?: number;
  /** Reconnection delay suggested to EventSource-style clients */
  retryMs?: number;
}

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

export function openEventStream(req: Request, res: Response, options: EventStreamOptions = {}): EventStream {
  const listeners: Array<() => void> = [];
  let closed = false;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform stops compressing proxies from buffering the stream; X-Accel-Buffering does the same for nginx
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket.setNoDelay(true);
  // Long-lived by design: the server's idle timeouts are for requests, not for this response
  req.socket.setTimeout(0);
  if (options.retryMs) res.write(`retry: ${Math.round(options.retryMs)}\n\n`);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, options.heartbeatMs ?? 20_000);
  heartbeat.unref();

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch {
        // a failing cleanup must not stop the others
      }
    }
  };
  req.on('close', finish);
  res.on('close', finish);

  return {
    get closed() {
      return closed;
    },
    send(event, data, id) {
      // A malformed name or id is a programming error: refuse it even on a closed stream
      if (!SAFE_TOKEN.test(event)) throw new Error(`Invalid event name '${event}'`);
      if (id !== undefined && !SAFE_TOKEN.test(id)) throw new Error(`Invalid event id '${id}'`);
      if (closed) return false;
      const json = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${json}\n\n`);
      return true;
    },
    comment(text) {
      if (!closed) res.write(`: ${text.replace(/[\r\n]+/g, ' ')}\n\n`);
    },
    close() {
      if (closed) return;
      res.end();
      finish();
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
}
