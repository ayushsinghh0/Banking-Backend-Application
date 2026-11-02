import { http, HttpResponse } from 'msw';
import { server } from './server';
import { apiUrl } from './render';

/**
 * A real-time stream the test controls: every connection the app opens is served by MSW, and `send`
 * writes an event to the newest one, framed exactly as the realtime service frames it.
 */
export function mockRealtimeStream() {
  const encoder = new TextEncoder();
  const connections: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; request: Request; closed: boolean }> = [];
  let sequence = 0;
  server.use(
    http.get(apiUrl('/realtime/stream'), ({ request }) => {
      let connection!: (typeof connections)[number];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          connection = { controller, request, closed: false };
          connections.push(connection);
        },
        cancel() {
          connection.closed = true;
        },
      });
      // MSW keeps a copy of every mocked body, so the client closing the stream shows up as the request's abort
      request.signal.addEventListener('abort', () => {
        connection.closed = true;
      });
      return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    })
  );
  const latest = () => {
    const connection = connections[connections.length - 1];
    if (!connection) throw new Error('The app has not opened the real-time stream yet');
    return connection;
  };
  return {
    connections,
    /** Writes `{ id, type, at, data }` as the service does */
    send(type: string, data: unknown) {
      sequence += 1;
      const id = String(sequence);
      const envelope = { id, type, at: new Date().toISOString(), data };
      latest().controller.enqueue(encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`));
    },
    /** Writes raw event-stream text */
    write(text: string) {
      latest().controller.enqueue(encoder.encode(text));
    },
    /** The server ends the newest stream */
    end() {
      const connection = latest();
      connection.closed = true;
      connection.controller.close();
    },
    get openCount() {
      return connections.filter((c) => !c.closed).length;
    },
  };
}

export type RealtimeMock = ReturnType<typeof mockRealtimeStream>;
