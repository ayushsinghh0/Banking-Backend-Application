/**
 * The assistant over HTTP (design section 7): conversations scoped to their owner, answers streamed as
 * Server-Sent Events (or JSON on request), refusals before the stream opens, and the per-user message rate.
 */
import './support/env';
import request from 'supertest';
import { AuthenticatedUser, InMemoryTokenStateStore, generateJwtKeyPair, signAccessToken } from '@banksphere/common';

const keys = generateJwtKeyPair();
process.env.JWT_SIGNING_KEY = keys.privateKeyB64;
process.env.JWT_SIGNING_KEY_ID = 'test-kid';
process.env.JWT_VERIFY_KEYS = `test-kid:${keys.publicKeyB64}`;

import { ASSISTANT_PREFIX, createApp } from '../src/app';
import { MemoryTurnLimits } from '../src/guardrails/limits';
import { BuiltinProvider } from '../src/providers/builtin-provider';
import { createTools } from '../src/tools/tools';
import { articles, customer, fakeApi, policy, teller } from './helpers';
import { MemoryConversationStore } from './support/memory-store';

const other: AuthenticatedUser = { id: '5e6f7a8b-0d55-4bb4-9a43-6f0d8f1f0a03', email: 'ravi@example.com', role: 'CUSTOMER' };
const tokenFor = (user: AuthenticatedUser) =>
  `Bearer ${signAccessToken({ sub: user.id, email: user.email, role: user.role, tokenVersion: 0, mfa: Boolean(user.mfa), sessionId: `s-${user.id}` })}`;

function build(options: { burst?: number } = {}) {
  const store = new MemoryConversationStore();
  const api = fakeApi();
  const builtin = new BuiltinProvider({ articles, wordDelayMs: 0 });
  const { app } = createApp({
    config: { historyMessages: 10, retentionDays: 30 },
    store,
    tools: createTools({ api, articles, policy }),
    provider: builtin,
    fallback: builtin,
    limits: new MemoryTurnLimits({ rate: { limit: 20, periodMs: 60_000, burst: options.burst ?? 5 }, dailyTokenBudget: 100_000 }),
    tokenState: new InMemoryTokenStateStore(),
    staffNetworks: null,
    heartbeatMs: 60_000,
  });
  const as = (user: AuthenticatedUser) => ({
    get: (path: string) => request(app).get(`${ASSISTANT_PREFIX}${path}`).set('authorization', tokenFor(user)),
    post: (path: string, body?: object) => request(app).post(`${ASSISTANT_PREFIX}${path}`).set('authorization', tokenFor(user)).send(body),
    delete: (path: string) => request(app).delete(`${ASSISTANT_PREFIX}${path}`).set('authorization', tokenFor(user)),
  });
  const start = async (user: AuthenticatedUser = customer) => (await as(user).post('/conversations', {})).body.data.id as string;
  return { app, store, api, as, start };
}

/** Parses a text/event-stream body into its events (comments and heartbeats skipped) */
function events(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').filter((line) => line && !line.startsWith(':')))
    .filter((lines) => lines.length)
    .map((lines) => ({
      event: lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message',
      data: JSON.parse(lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')),
    }));
}

describe('assistant over HTTP', () => {
  it('meta names the engine and role-specific suggestions', async () => {
    const { as } = build();
    const mine = (await as(customer).get('/meta')).body.data;
    const staff = (await as(teller).get('/meta')).body.data;
    expect(mine.provider).toBe('builtin');
    expect(mine.suggestions.length).toBeGreaterThan(0);
    expect(staff.suggestions).not.toEqual(mine.suggestions);
  });

  it('streams an answer: message.start, tool events with a card, tokens, message.end; then it is stored', async () => {
    const { as, start, store } = build();
    const id = await start();
    const res = await as(customer).post(`/conversations/${id}/messages`, { content: 'What is my balance?' }).buffer(true).parse((r, cb) => {
      let text = '';
      r.on('data', (c: Buffer) => (text += c.toString()));
      r.on('end', () => cb(null, text));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const stream = events(res.body as string);
    const types = stream.map((e) => e.event);
    expect(types[0]).toBe('message.start');
    expect(types.at(-1)).toBe('message.end');
    expect(types).toContain('token');
    const toolResult = stream.find((e) => e.event === 'tool.result');
    expect(toolResult?.data).toMatchObject({ name: 'list_accounts', card: { type: 'accounts' } });
    // Masked: the card shows the last 4 digits, never the full account number
    expect(JSON.stringify(toolResult?.data)).not.toContain('200000001234');
    expect(stream[0].data.messageId).toBe(stream.at(-1)!.data.messageId);

    const thread = (await as(customer).get(`/conversations/${id}`)).body.data;
    expect(thread.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(thread.messages[1]).toMatchObject({ id: stream[0].data.messageId, status: 'complete', cards: [expect.objectContaining({ type: 'accounts' })] });
    expect(thread.title).toBe('What is my balance?');
    expect(store.messages).toHaveLength(2);
  });

  it('answers with the final message as JSON when the client asks for it', async () => {
    const { as, start } = build();
    const id = await start();
    const res = await as(customer).post(`/conversations/${id}/messages`, { content: 'Show my last 5 transactions' }).set('accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'assistant', status: 'complete', cards: [expect.objectContaining({ type: 'transactions' })] });
  });

  it("someone else's conversation is 404 everywhere, never a 403, and is left untouched", async () => {
    const { as, start, store } = build();
    const id = await start(customer);
    expect((await as(other).get(`/conversations/${id}`)).status).toBe(404);
    expect((await as(other).post(`/conversations/${id}/messages`, { content: 'hi' })).status).toBe(404);
    expect((await as(other).delete(`/conversations/${id}`)).status).toBe(404);
    expect((await as(other).get('/conversations')).body.data.items).toEqual([]);
    expect(store.conversations.has(id)).toBe(true);
    expect((await as(customer).get('/conversations/not-a-uuid')).status).toBe(404);
    expect((await as(customer).delete(`/conversations/${id}`)).body.data).toEqual({ id, deleted: true });
    expect((await as(customer).get(`/conversations/${id}`)).status).toBe(404);
  });

  it('refuses bad messages as ordinary JSON errors before any stream opens, storing nothing', async () => {
    const { as, start, store } = build();
    const id = await start();
    const send = (body: object) => as(customer).post(`/conversations/${id}/messages`, body);
    expect((await send({ content: '   ' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await send({ content: '\u0000‮' })).status).toBe(400);
    const long = await send({ content: 'x'.repeat(2001) });
    expect([long.status, long.body.error.code, long.headers['content-type']]).toEqual([400, 'MESSAGE_TOO_LONG', expect.stringMatching(/json/)]);
    expect((await send({ content: 'hi', role: 'system' })).status).toBe(400);
    expect(store.messages).toHaveLength(0);
  });

  it('limits messages per user (GCRA burst), with Retry-After, without affecting anyone else', async () => {
    const { as, start } = build({ burst: 2 });
    const id = await start();
    const otherId = await start(other);
    const send = (user: AuthenticatedUser, conversation: string) =>
      as(user).post(`/conversations/${conversation}/messages`, { content: 'help' }).set('accept', 'application/json');
    expect((await send(customer, id)).status).toBe(200);
    expect((await send(customer, id)).status).toBe(200);
    const limited = await send(customer, id);
    expect([limited.status, limited.body.error.code]).toEqual([429, 'RATE_LIMIT_EXCEEDED']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await send(other, otherId)).status).toBe(200);
  });

  it('staff get the help tool only: asking for balances never reaches the banking APIs', async () => {
    const { as, start, api } = build();
    const id = await start(teller);
    const res = await as(teller).post(`/conversations/${id}/messages`, { content: 'What is my balance?' }).set('accept', 'application/json');
    expect(res.status).toBe(200);
    expect(api.calls).toEqual([]);
  });

  it('requires a signed-in user', async () => {
    const { app } = build();
    expect((await request(app).get(`${ASSISTANT_PREFIX}/meta`)).status).toBe(401);
    expect((await request(app).post(`${ASSISTANT_PREFIX}/conversations`).send({})).status).toBe(401);
  });
});
