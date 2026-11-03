import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok } from '@/test/render';
import { ApiClient } from '@/lib/api/client';
import { describeAssistantError, streamReply, type ReplyEvent } from './stream';

const client = () => new ApiClient({ getAccessToken: () => 'tok', refreshAccessToken: async () => 'tok', onSessionExpired: () => {} });

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (text: string) => new HttpResponse(text, { headers: { 'Content-Type': 'text/event-stream' } });

async function run(response: () => Response, signal = new AbortController().signal) {
  let body: unknown;
  server.use(
    http.post(apiUrl('/assistant/conversations/c1/messages'), async ({ request }) => {
      body = await request.json();
      return response();
    })
  );
  const events: ReplyEvent[] = [];
  const outcome = await streamReply(client(), 'c1', 'What is my balance?', (e) => events.push(e), signal);
  return { outcome, events, body };
}

describe('streamReply', () => {
  it('posts the message and turns the stream into reply events', async () => {
    const { outcome, events, body } = await run(() =>
      sse(
        frame('message.start', { messageId: 'm1' }) +
          frame('tool.call', { name: 'list_accounts', label: 'Checking your accounts…' }) +
          frame('tool.result', { name: 'list_accounts', card: { type: 'accounts', accounts: [{ id: 'a1', label: 'Savings', last4: '6789', balancePaise: '100' }] } }) +
          frame('tool.result', { name: 'search_help', card: { type: 'iframe', src: 'x' } }) +
          frame('token', { text: 'You have ' }) +
          frame('token', { text: '₹1.00.' }) +
          frame('message.end', { messageId: 'm1' })
      )
    );
    expect(body).toEqual({ content: 'What is my balance?' });
    expect(outcome).toBe('ended');
    expect(events).toEqual([
      { type: 'start', messageId: 'm1' },
      { type: 'tool', name: 'list_accounts', label: 'Checking your accounts…' },
      { type: 'result', name: 'list_accounts', card: { type: 'accounts', accounts: [{ id: 'a1', label: 'Savings', last4: '6789', balancePaise: '100' }] } },
      { type: 'result', name: 'search_help', card: null },
      { type: 'token', text: 'You have ' },
      { type: 'token', text: '₹1.00.' },
      { type: 'end', messageId: 'm1' },
    ]);
  });

  it('reports an error event', async () => {
    const { outcome, events } = await run(() => sse(frame('error', { code: 'LLM_TIMEOUT', message: 'took too long' })));
    expect(outcome).toBe('error');
    expect(events).toEqual([{ type: 'error', code: 'LLM_TIMEOUT', message: 'took too long' }]);
  });

  it('says when the stream stopped before the answer ended', async () => {
    const { outcome } = await run(() => sse(frame('token', { text: 'Half an ans' })));
    expect(outcome).toBe('interrupted');
  });

  it('accepts a whole JSON message when the server does not stream', async () => {
    const { outcome, events } = await run(() =>
      ok({ id: 'm2', role: 'assistant', content: 'Here is how.', cards: [{ type: 'help', title: 'Add a payee', steps: ['Open Payees'] }], createdAt: 'x' })
    );
    expect(outcome).toBe('ended');
    expect(events).toEqual([
      { type: 'start', messageId: 'm2' },
      { type: 'result', name: 'help', card: { type: 'help', title: 'Add a payee', steps: ['Open Payees'] } },
      { type: 'token', text: 'Here is how.' },
      { type: 'end', messageId: 'm2' },
    ]);
  });

  it('throws the API error when the request is refused', async () => {
    await expect(run(() => fail(429, 'RATE_LIMIT_EXCEEDED', 'slow down'))).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('stops reading when aborted', async () => {
    const controller = new AbortController();
    const onEvent = vi.fn((e: ReplyEvent) => {
      if (e.type === 'token') controller.abort();
    });
    server.use(
      http.post(apiUrl('/assistant/conversations/c1/messages'), () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(frame('token', { text: 'Once' })));
          },
        });
        return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
      })
    );
    await expect(streamReply(client(), 'c1', 'hi', onEvent, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('describeAssistantError', () => {
  it('explains the assistant’s own limits', () => {
    expect(describeAssistantError('TOKEN_BUDGET_EXCEEDED').title).toBe('Daily limit reached');
    expect(describeAssistantError('RATE_LIMIT_EXCEEDED').title).toBe('Too many messages');
    expect(describeAssistantError('LLM_TIMEOUT').title).toBe('Sphere took too long');
    expect(describeAssistantError('MESSAGE_TOO_LONG').title).toBe('Message too long');
    expect(describeAssistantError('SOMETHING_ELSE').title).toBe('Sphere couldn’t answer');
  });
});
