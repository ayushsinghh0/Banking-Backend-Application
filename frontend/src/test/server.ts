import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * The signed-in shell keeps a real-time stream open in the background. Unless a test takes it over
 * (`mockRealtimeStream` in ./realtime), it gets a quiet stream: connected, sending nothing.
 */
const quietRealtimeStream = http.get(
  'http://localhost:3000/api/v1/realtime/stream',
  () => new HttpResponse(new ReadableStream<Uint8Array>(), { headers: { 'Content-Type': 'text/event-stream' } })
);

/** Every test registers the handlers it needs; unhandled requests fail the test. */
export const server = setupServer(quietRealtimeStream);
