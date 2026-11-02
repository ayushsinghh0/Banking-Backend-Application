import { describe, expect, it, vi } from 'vitest';
import { SseParser, readEventStream, type SseEvent } from './sse';

function collect() {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = new SseParser({
    onEvent: (e) => events.push(e),
    onComment: (c) => comments.push(c),
    onRetry: (ms) => retries.push(ms),
  });
  return { parser, events, comments, retries };
}

/** A body that yields the given byte chunks, then ends */
function body(chunks: Array<string | Uint8Array>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

describe('SseParser', () => {
  it('dispatches an event with its type, data and id at the blank line', () => {
    const { parser, events } = collect();
    parser.feed('id: 7\nevent: payment.updated\ndata: {"topUpId":"t1"}\n');
    expect(events).toEqual([]);
    parser.feed('\n');
    expect(events).toEqual([{ type: 'payment.updated', data: '{"topUpId":"t1"}', id: '7' }]);
    expect(parser.lastEventId).toBe('7');
  });

  it('joins data lines with newlines and defaults the type to message', () => {
    const { parser, events } = collect();
    parser.feed('data: first\ndata:second\ndata\n\n');
    expect(events).toEqual([{ type: 'message', data: 'first\nsecond\n', id: '' }]);
  });

  it('strips exactly one space after the colon', () => {
    const { parser, events } = collect();
    parser.feed('data:  two spaces\n\n');
    expect(events[0]?.data).toBe(' two spaces');
  });

  it('reports comments (heartbeats) without dispatching anything', () => {
    const { parser, events, comments } = collect();
    parser.feed(': heartbeat\n:\n\n');
    expect(comments).toEqual(['heartbeat', '']);
    expect(events).toEqual([]);
  });

  it('accepts LF, CRLF and CR line endings, including a CRLF split across chunks', () => {
    const { parser, events } = collect();
    parser.feed('data: a\r\n\r\ndata: b\r\rdata: c\r');
    parser.feed('\n\r\n');
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('reassembles lines split anywhere between chunks', () => {
    const { parser, events } = collect();
    for (const piece of ['ev', 'ent: tok', 'en\nda', 'ta: {"text":"Hel', 'lo"}', '\n', '\n']) parser.feed(piece);
    expect(events).toEqual([{ type: 'token', data: '{"text":"Hello"}', id: '' }]);
  });

  it('does not dispatch an event without data, but still takes its id', () => {
    const { parser, events } = collect();
    parser.feed('id: 41\nevent: ping\n\n');
    expect(events).toEqual([]);
    expect(parser.lastEventId).toBe('41');
    parser.feed('data: x\n\n');
    expect(events).toEqual([{ type: 'message', data: 'x', id: '41' }]);
  });

  it('keeps the last id for later events, resets it when empty, and ignores ids with NULL', () => {
    const { parser, events } = collect();
    parser.feed('id: 5\ndata: a\n\ndata: b\n\nid: bad\u0000\ndata: c\n\nid\ndata: d\n\n');
    expect(events.map((e) => [e.data, e.id])).toEqual([
      ['a', '5'],
      ['b', '5'],
      ['c', '5'],
      ['d', ''],
    ]);
  });

  it('applies a retry field only when it is all digits', () => {
    const { parser, retries } = collect();
    parser.feed('retry: 2500\nretry: 1.5\nretry: soon\n\n');
    expect(retries).toEqual([2500]);
  });

  it('ignores unknown fields and a leading byte-order mark', () => {
    const { parser, events } = collect();
    parser.feed('\uFEFFdata: hi\nfoo: bar\n\n');
    expect(events).toEqual([{ type: 'message', data: 'hi', id: '' }]);
  });

  it('resets the event type after each dispatch', () => {
    const { parser, events } = collect();
    parser.feed('event: ready\ndata: {}\n\ndata: plain\n\n');
    expect(events.map((e) => e.type)).toEqual(['ready', 'message']);
  });
});

describe('readEventStream', () => {
  it('decodes UTF-8 split across chunks and drops an unfinished event at the end', async () => {
    const rupee = new TextEncoder().encode('data: ₹500\n\n');
    // Split inside the three bytes of "₹"
    const onEvent = vi.fn();
    const onActivity = vi.fn();
    await readEventStream(body([rupee.slice(0, 7), rupee.slice(7), 'data: unfinished']), { onEvent, onActivity });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'message', data: '₹500', id: '' });
    expect(onActivity).toHaveBeenCalled();
  });

  it('cancels the body and rejects with an AbortError when aborted', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': open\n\n'));
      },
      cancel,
    });
    const controller = new AbortController();
    const reading = readEventStream(stream, { onEvent: () => {}, onComment: () => controller.abort() }, controller.signal);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects straight away when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readEventStream(body(['data: x\n\n']), { onEvent: () => {} }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
