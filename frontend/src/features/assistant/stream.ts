import type { ApiClient } from '@/lib/api/client';
import { normalizeCard, normalizeCards } from '@/lib/api/cards';
import type { AssistantCard, AssistantMessage } from '@/lib/api/types';
import { readEventStream } from '@/lib/realtime/sse';

/** What happens while Sphere answers, in the order the assistant service sends it */
export type ReplyEvent =
  | { type: 'start'; messageId: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'result'; name: string; card: AssistantCard | null }
  | { type: 'token'; text: string }
  | { type: 'end'; messageId: string }
  | { type: 'error'; code: string; message: string };

/** `ended`: a complete answer; `error`: the service reported one; `interrupted`: the stream stopped early */
export type ReplyOutcome = 'ended' | 'error' | 'interrupted';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

function toReplyEvent(type: string, data: Record<string, unknown>): ReplyEvent | null {
  switch (type) {
    case 'message.start':
      return { type: 'start', messageId: str(data.messageId) };
    case 'tool.call':
      return { type: 'tool', name: str(data.name), label: str(data.label) };
    case 'tool.result':
      return { type: 'result', name: str(data.name), card: normalizeCard(data.card) };
    case 'token':
      return { type: 'token', text: str(data.text) };
    case 'message.end':
      return { type: 'end', messageId: str(data.messageId) };
    case 'error':
      return { type: 'error', code: str(data.code) || 'ASSISTANT_ERROR', message: str(data.message) };
    default:
      return null;
  }
}

/**
 * Sends one message (`POST /assistant/conversations/:id/messages`) and reads the answer as it streams.
 * HTTP refusals reject with an ApiError; aborting `signal` rejects with an AbortError and closes the stream.
 */
export async function streamReply(
  client: ApiClient,
  conversationId: string,
  content: string,
  onEvent: (event: ReplyEvent) => void,
  signal: AbortSignal
): Promise<ReplyOutcome> {
  const response = await client.stream(`/assistant/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { content },
    headers: { Accept: 'text/event-stream, application/json;q=0.5' },
    signal,
  });

  if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    // A server that answers in one piece: replay it as the same events
    const envelope = (await response.json()) as { data?: AssistantMessage };
    const message = envelope.data;
    const messageId = str(message?.id);
    onEvent({ type: 'start', messageId });
    for (const card of normalizeCards(message?.cards)) onEvent({ type: 'result', name: card.type, card });
    if (message?.content) onEvent({ type: 'token', text: message.content });
    onEvent({ type: 'end', messageId });
    return 'ended';
  }

  let outcome: ReplyOutcome = 'interrupted';
  if (!response.body) return outcome;
  await readEventStream(
    response.body,
    {
      onEvent: (frame) => {
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(frame.data);
          if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        const event = toReplyEvent(frame.type, data);
        if (!event) return;
        if (event.type === 'end') outcome = 'ended';
        if (event.type === 'error') outcome = 'error';
        onEvent(event);
      },
    },
    signal
  );
  return outcome;
}

/** Plain words for the assistant's own refusals and failures, matched on their codes */
export function describeAssistantError(code: string): { title: string; description: string } {
  const c = code.toUpperCase();
  if (c.includes('BUDGET') || c.includes('QUOTA') || c.includes('DAILY')) {
    return { title: 'Daily limit reached', description: 'You’ve used today’s allowance for Sphere. Try again tomorrow.' };
  }
  if (c.includes('RATE') || c.includes('TOO_MANY')) return { title: 'Too many messages', description: 'Wait a moment, then try again.' };
  if (c.includes('TIMEOUT')) return { title: 'Sphere took too long', description: 'Try again, or ask a shorter question.' };
  if (c.includes('TOO_LONG') || c === 'VALIDATION_ERROR') return { title: 'Message too long', description: 'Keep your message under 2,000 characters.' };
  return { title: 'Sphere couldn’t answer', description: 'Something went wrong on our side. Try again in a moment.' };
}
