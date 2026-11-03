import { Request } from 'express';
import { AuthenticatedUser, logger } from '@banksphere/common';
import { loadPolicy } from '../src/config';
import { buildArticles } from '../src/knowledge/articles';
import { BankingApi, ToolContext } from '../src/tools/banking-api';
import { createTools, toolsFor } from '../src/tools/tools';
import { ToolRunner } from '../src/assistant/tool-runner';
import { TurnEvent } from '../src/assistant/types';
import { emptyUsage, TurnInput } from '../src/providers/provider';

export const NOW = new Date('2026-10-28T06:30:00Z');
export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const policy = loadPolicy({});
export const articles = buildArticles(policy);

export const customer: AuthenticatedUser = { id: '0b8f2a52-0d55-4bb4-9a43-6f0d8f1f0a01', email: 'asha@example.com', role: 'CUSTOMER' };
export const teller: AuthenticatedUser = { id: '7c1d2e3f-0d55-4bb4-9a43-6f0d8f1f0a02', email: 'teller@bank.test', role: 'TELLER', mfa: true };

/** An in-memory stand-in for the owning services (what they would return to this customer) */
export function fakeApi(overrides: Partial<BankingApi> = {}): BankingApi & { calls: string[] } {
  const calls: string[] = [];
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push(name);
      return fn(...args);
    };
  const api: BankingApi = {
    listAccounts: async () => [{ id: ACCOUNT_ID, accountNumber: '200000001234', accountType: 'SAVINGS', status: 'ACTIVE', dailyLimitPaise: '10000000' }],
    getBalance: async () => ({ accountId: ACCOUNT_ID, balanceInPaise: '1234567' }),
    getHistory: async (_ctx, _id, limit, offset) =>
      offset > 0
        ? []
        : [
            { entryId: 'e1', transactionId: 't1', type: 'TRANSFER', entryType: 'CREDIT' as const, amountInPaise: '500000', description: 'Salary', createdAt: '2026-10-27T05:00:00Z' },
            { entryId: 'e2', transactionId: 't2', type: 'TRANSFER', entryType: 'DEBIT' as const, amountInPaise: '150000', description: 'Rent', createdAt: '2026-10-26T05:00:00Z' },
          ].slice(0, limit),
    listBeneficiaries: async () => [{ id: 'b1', accountNumber: '200000004321', nickname: 'Mom', activatesAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }],
    getProfile: async () => ({ kycStatus: 'VERIFIED' }),
    listTopUps: async () => [{ id: 'tu1', amountPaise: '250000', status: 'CREDITED', createdAt: '2026-10-27T05:00:00Z' }],
    getPaymentConfig: async () => ({ limits: { minPaise: '100', maxPaise: '10000000', remainingTodayPaise: '20000000' } }),
    ...overrides,
  };
  const tracked = Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, track(k, fn as any)])) as unknown as BankingApi;
  return Object.assign(tracked, { calls });
}

export function fakeRequest(): Request {
  return { header: () => undefined, correlationId: 'test', ip: '127.0.0.1' } as unknown as Request;
}

export function turnInput(
  message: string,
  options: { user?: AuthenticatedUser; api?: BankingApi; signal?: AbortSignal; history?: TurnInput['history'] } = {}
): TurnInput & { events: TurnEvent[] } {
  const user = options.user ?? customer;
  const signal = options.signal ?? new AbortController().signal;
  const events: TurnEvent[] = [];
  const emit = (event: TurnEvent) => events.push(event);
  const ctx: ToolContext = { user, request: fakeRequest(), signal };
  const tools = toolsFor(user, createTools({ api: options.api ?? fakeApi(), articles, policy, now: () => NOW }));
  return {
    user,
    history: options.history ?? [],
    message,
    tools: new ToolRunner(tools, ctx, emit, logger),
    signal,
    emit,
    usage: emptyUsage(),
    now: NOW,
    events,
  };
}

export const tokensOf = (events: TurnEvent[]) =>
  events
    .filter((e): e is Extract<TurnEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.text)
    .join('');

// --- scripted OpenAI-compatible streams ---------------------------------------------------------------------------

export const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
export const usageChunk = (prompt: number, completion: number) =>
  `data: ${JSON.stringify({ id: 'c', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`;
export const DONE = 'data: [DONE]\n\n';

/** A text answer split into chunks, with usage and [DONE] */
export const textAnswer = (parts: string[], usage: [number, number] = [100, 20]) => [
  ...parts.map((p, i) => chunk({ ...(i === 0 && { role: 'assistant' }), content: p })),
  chunk({}, 'stop'),
  usageChunk(...usage),
  DONE,
];

export interface ScriptedStream {
  /** Raw pieces of the response body, delivered one per read */
  pieces: Array<string | Uint8Array>;
  /** Keep the stream open after the pieces (never ends unless aborted) */
  hang?: boolean;
  status?: number;
}

/** fetch that answers each call with the next script and records every request */
export function scriptedFetch(scripts: Array<ScriptedStream | (() => never)>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any; signal: AbortSignal }> = [];
  const fetchImpl = jest.fn(async (url: string | URL | globalThis.Request, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal;
    requests.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), signal });
    const script = scripts.shift();
    if (!script) throw new Error('No scripted response left');
    if (typeof script === 'function') script();
    const s = script as ScriptedStream;
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < s.pieces.length) {
          const piece = s.pieces[i++];
          controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece);
          return;
        }
        if (!s.hang) {
          controller.close();
          return;
        }
        // Hang until the request is aborted, like a stalled provider
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    return new Response(stream, { status: s.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}
