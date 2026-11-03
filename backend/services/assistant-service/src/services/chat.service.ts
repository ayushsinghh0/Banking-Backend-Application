import crypto from 'crypto';
import { Request } from 'express';
import { AuthenticatedUser, Logger, logger } from '@banksphere/common';
import { LlmError, TurnAbortedError } from '../assistant/errors';
import { ToolRunner } from '../assistant/tool-runner';
import { StreamEvent, TokenUsage, TurnEvent } from '../assistant/types';
import { AssistantErrors, MessageRateLimitedError } from '../errors';
import { TurnLimits } from '../guardrails/limits';
import { llmTokensTotal, messagesTotal, responseSeconds } from '../metrics';
import { AnswerProvider, emptyUsage, TurnInput } from '../providers/provider';
import { ConversationRecord, ConversationStore, MessageRecord, MessageStatus } from '../store/conversation-store';
import { ToolSpec, toolsFor } from '../tools/tools';
import { cleanText } from '../util/masking';
import { istDate } from '../util/money';

export const MAX_MESSAGE_CHARS = 2_000;
/** Longest conversation title derived from a first message */
const TITLE_CHARS = 60;

export interface ChatServiceDeps {
  store: ConversationStore;
  tools: readonly ToolSpec[];
  /** What answers normally: the model, or the built-in assistant when no key is configured */
  provider: AnswerProvider;
  /** Answers when the model can't: its spend can't be accounted for, or it failed before saying anything */
  fallback: AnswerProvider;
  limits: TurnLimits;
  historyMessages: number;
  now?: () => Date;
}

/** Where the turn's events go: the SSE stream, or nowhere (JSON mode) */
export interface TurnSink {
  send(event: StreamEvent): void;
}

export interface Admission {
  provider: AnswerProvider;
  /** IST day the token budget belongs to */
  day: string;
  /** Set when the built-in assistant answers in the model's place */
  fallbackReason?: 'budget_unknown';
}

export interface PreparedTurn {
  user: AuthenticatedUser;
  conversation: ConversationRecord;
  content: string;
  /** Earlier turns, oldest first, as the provider receives them */
  history: TurnInput['history'];
}

export type TurnResult = 'ok' | 'fallback' | 'aborted' | 'error';

export interface TurnOutcome {
  message: MessageRecord;
  result: TurnResult;
  /** The in-band error the client was (or would be) told about */
  failure: { code: string; message: string } | null;
}

export const NO_SINK: TurnSink = { send: () => undefined };

/**
 * One message, start to finish: the guardrails, the user's turn, the provider's answer streamed as events, and the
 * assistant's turn recorded with how it was produced. Nothing here logs a message body: logs carry ids, codes
 * and timings only.
 */
export class ChatService {
  private readonly now: () => Date;

  constructor(private readonly deps: ChatServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  public get provider(): AnswerProvider {
    return this.deps.provider;
  }

  /**
   * May this user send one more message now? The message rate first (429 RATE_LIMIT_EXCEEDED), then, when the model
   * answers, today's token budget (429 TOKEN_BUDGET_EXCEEDED). A budget that can't be read never blocks the user:
   * the built-in assistant answers instead, so no unaccounted tokens are spent.
   */
  public async admit(user: AuthenticatedUser, log: Logger = logger): Promise<Admission> {
    const rate = await this.deps.limits.checkRate(user.id);
    if (!rate.allowed) throw new MessageRateLimitedError(Math.max(1, Math.ceil(rate.retryAfterMs / 1000)));

    const day = istDate(this.now());
    if (this.deps.provider.kind !== 'llm') return { provider: this.deps.provider, day };

    const budget = await this.deps.limits.checkBudget(user.id, day);
    if (budget.state === 'exhausted') {
      messagesTotal.inc({ provider: 'llm', result: 'budget_exhausted' });
      throw AssistantErrors.tokenBudgetExceeded();
    }
    if (budget.state === 'unknown') {
      log.warn({ userId: user.id }, 'Token budget unavailable; the built-in assistant answers this message');
      return { provider: this.deps.fallback, day, fallbackReason: 'budget_unknown' };
    }
    return { provider: this.deps.provider, day };
  }

  /** Reads the context and records the user's turn. Anything that fails here is an ordinary HTTP error. */
  public async prepare(user: AuthenticatedUser, conversation: ConversationRecord, content: string): Promise<PreparedTurn> {
    const earlier = await this.deps.store.recentMessages(conversation.id, this.deps.historyMessages);
    const history = earlier.filter((m) => m.content.length > 0).map((m) => ({ role: m.role, content: m.content }));
    await this.deps.store.appendMessage(
      { conversationId: conversation.id, role: 'user', content },
      { titleIfUnset: conversation.title ? undefined : cleanText(content, TITLE_CHARS) }
    );
    return { user, conversation, content, history };
  }

  /**
   * Produces the answer. Never throws: the client learns about failures through the `error` event (or the outcome),
   * and the assistant's turn is stored whatever happened, so the thread shows what the user actually saw.
   */
  public async answer(turn: PreparedTurn, admission: Admission, io: { request: Request; signal: AbortSignal; sink: TurnSink }): Promise<TurnOutcome> {
    const log = io.request.log ?? logger;
    const startedAt = Date.now();
    const messageId = crypto.randomUUID();
    io.sink.send({ type: 'message.start', messageId });

    let content = '';
    const emit = (event: TurnEvent) => {
      if (event.type === 'token') content += event.text;
      io.sink.send(event);
    };
    const runner = new ToolRunner(toolsFor(turn.user, this.deps.tools), { user: turn.user, request: io.request, signal: io.signal }, emit, log);
    const usage = emptyUsage();
    const input: TurnInput = { user: turn.user, history: turn.history, message: turn.content, tools: runner, signal: io.signal, emit, usage, now: this.now() };

    let provider = admission.provider;
    let result: TurnResult = admission.fallbackReason ? 'fallback' : 'ok';
    let status: MessageStatus = 'complete';
    let failure: TurnOutcome['failure'] = null;
    try {
      try {
        await provider.respond(input);
      } catch (error) {
        if (!this.canFallBack(provider, error, content, runner, io.signal)) throw error;
        // Nothing has reached the user yet, so the built-in assistant can still answer the same question
        log.warn({ code: (error as LlmError).code, upstreamStatus: (error as LlmError).status }, 'Model provider failed before answering; the built-in assistant answers');
        provider = this.deps.fallback;
        result = 'fallback';
        await provider.respond(input);
      }
    } catch (error) {
      if (error instanceof TurnAbortedError || io.signal.aborted) {
        status = 'interrupted';
        result = 'aborted';
      } else {
        status = 'failed';
        result = 'error';
        failure = describeFailure(error);
        log.error({ err: error instanceof LlmError ? { code: error.code, upstreamStatus: error.status } : error, messageId }, 'Assistant answer failed');
      }
    }

    const latencyMs = Date.now() - startedAt;
    // The provider did the work whether or not the answer finished: it counts against the budget either way
    await this.deps.limits.recordTokens(turn.user.id, admission.day, usage.promptTokens + usage.completionTokens);
    observe(provider.kind, result, latencyMs, usage);

    const record = {
      id: messageId,
      conversationId: turn.conversation.id,
      role: 'assistant' as const,
      content,
      cards: runner.cards,
      toolNames: runner.toolNames,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      provider: provider.kind,
      model: provider.model ?? null,
      latencyMs,
      status,
    };
    let message: MessageRecord;
    try {
      message = await this.deps.store.appendMessage(record);
    } catch (error) {
      // The user has the answer; a storage problem must not turn it into a failure, but the thread will miss it
      log.error({ err: error, messageId, conversationId: turn.conversation.id }, 'Assistant message could not be stored');
      message = { ...record, createdAt: this.now() };
    }

    if (failure) io.sink.send({ type: 'error', ...failure });
    else if (status === 'complete') io.sink.send({ type: 'message.end', messageId });
    return { message, result, failure };
  }

  private canFallBack(provider: AnswerProvider, error: unknown, content: string, runner: ToolRunner, signal: AbortSignal): boolean {
    return (
      provider.kind === 'llm' &&
      provider !== this.deps.fallback &&
      error instanceof LlmError &&
      !signal.aborted &&
      content.length === 0 &&
      runner.toolNames.length === 0
    );
  }
}

const FAILURE_MESSAGES: Record<LlmError['code'], string> = {
  LLM_TIMEOUT: 'Sphere took too long to answer. Please try again.',
  LLM_UNAVAILABLE: 'Sphere is unavailable right now. Please try again in a moment.',
  LLM_REJECTED: 'Sphere can’t answer right now. Please try again later.',
  LLM_BAD_RESPONSE: 'Sphere’s answer couldn’t be read. Please try again.',
};

/** What the client is told: our words and a code, never the provider's or a stack trace */
function describeFailure(error: unknown): NonNullable<TurnOutcome['failure']> {
  if (error instanceof LlmError) return { code: error.code, message: FAILURE_MESSAGES[error.code] };
  return { code: 'ASSISTANT_ERROR', message: 'Something went wrong while answering. Please try again.' };
}

function observe(provider: AnswerProvider['kind'], result: TurnResult, latencyMs: number, usage: TokenUsage): void {
  messagesTotal.inc({ provider, result });
  responseSeconds.observe({ provider, result }, latencyMs / 1000);
  if (usage.promptTokens > 0) llmTokensTotal.inc({ direction: 'prompt' }, usage.promptTokens);
  if (usage.completionTokens > 0) llmTokensTotal.inc({ direction: 'completion' }, usage.completionTokens);
}
