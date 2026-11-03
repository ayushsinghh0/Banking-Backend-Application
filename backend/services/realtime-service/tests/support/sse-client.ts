export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  raw: string;
}

/**
 * A minimal SSE reader over fetch for the HTTP tests: collects frames (and the raw text) as they arrive.
 */
export async function openSse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const frames: SseFrame[] = [];
  let raw = '';
  let buffer = '';
  let ended = false;
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((w) => w());

  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          raw += text;
          buffer += text;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const frame: SseFrame = { raw: `${block}\n\n` };
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) frame.comment = line.slice(1).trim();
              else if (line.startsWith('id: ')) frame.id = line.slice(4);
              else if (line.startsWith('event: ')) frame.event = line.slice(7);
              else if (line.startsWith('data: ')) frame.data = line.slice(6);
            }
            frames.push(frame);
          }
          notify();
        }
      } catch {
        // aborted
      } finally {
        ended = true;
        notify();
      }
    })();
  }

  /** Resolves once a frame matching `predicate` has arrived (or rejects after `timeoutMs`) */
  async function waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs = 3_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find(predicate);
      if (found) return found;
      if (ended) throw new Error(`stream ended without the expected frame; got: ${JSON.stringify(frames.map((f) => f.raw))}`);
      if (Date.now() > deadline) throw new Error(`timed out; got: ${JSON.stringify(frames.map((f) => f.raw))}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  async function waitForEnd(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ended) {
      if (Date.now() > deadline) throw new Error('stream did not end');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return {
    res,
    frames,
    get raw() {
      return raw;
    },
    get ended() {
      return ended;
    },
    waitFor,
    waitForEnd,
    close: () => controller.abort(),
  };
}
