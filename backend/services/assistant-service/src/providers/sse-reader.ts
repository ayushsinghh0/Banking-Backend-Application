import { LlmError } from '../assistant/errors';

/**
 * Reads a Server-Sent Events response body (the model provider's stream) as it arrives: any line ending
 * (\n, \r\n, \r), comments, multi-line data, events split across network chunks at any byte (including inside a
 * multi-byte character). Bounded: a provider that streams without end is cut off. Stops as soon as `signal` aborts.
 */
export interface SseMessage {
  event?: string;
  data: string;
}

const MAX_STREAM_BYTES = 4 * 1024 * 1024;

export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes = MAX_STREAM_BYTES): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });

  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let received = 0;

  // Returns a complete message when the line ends one
  const takeLine = (line: string): SseMessage | null => {
    if (line === '') {
      const message = data.length ? { ...(event !== undefined && { event }), data: data.join('\n') } : null;
      data = [];
      event = undefined;
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null;
  };

  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (signal.aborted) return;
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new LlmError('LLM_BAD_RESPONSE', 'The model provider’s answer was too long');
      buffer += decoder.decode(value, { stream: true });
      // A trailing \r may be the first half of \r\n: keep it until the next chunk
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = takeLine(line);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r\n|\n|\r/)) {
      const message = takeLine(line);
      if (message) yield message;
    }
    const last = takeLine('');
    if (last) yield last;
  } finally {
    signal.removeEventListener('abort', cancel);
    // Stopped early ([DONE], an error, an abort): release the connection instead of leaving the body unread
    cancel();
  }
}
