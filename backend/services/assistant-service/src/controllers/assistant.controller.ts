import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser, openEventStream } from '@banksphere/common';
import { suggestionsFor } from '../assistant/suggestions';
import { ProviderKind, StreamEvent } from '../assistant/types';
import { AssistantErrors, MessageRateLimitedError } from '../errors';
import { ChatService, MAX_MESSAGE_CHARS, NO_SINK, TurnSink } from '../services/chat.service';
import { ConversationRecord, ConversationStore, ConversationSummary, MessageRecord } from '../store/conversation-store';

/** Conversations in GET /conversations and messages in GET /conversations/:id (the latest ones) */
export const CONVERSATION_LIST_LIMIT = 20;
export const MESSAGE_PAGE_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters (except tab and newline) and bidirectional overrides have no place in a chat message
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

const createSchema = z.object({ title: z.string().trim().min(1).max(120).optional() }).strict();
const messageSchema = z.object({ content: z.string() }).strict();

export interface ProviderMeta {
  provider: ProviderKind;
  model?: string;
}

export interface ControllerOptions {
  /** Comment heartbeat on answer streams, so a long tool call doesn't look like a dead connection */
  heartbeatMs: number;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): Handler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof MessageRateLimitedError) res.setHeader('Retry-After', error.retryAfterSeconds);
      next(error);
    }
  };

const summaryView = (c: ConversationSummary) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() });

export const messageView = (m: MessageRecord) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  cards: m.cards,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
});

/** The user's message as stored: bounded, without control characters, never empty */
export function parseContent(body: unknown): string {
  const { content } = messageSchema.parse(body ?? {});
  const cleaned = content.replace(UNSAFE_CHARS, '').trim();
  if (!cleaned) throw AssistantErrors.emptyMessage();
  if (cleaned.length > MAX_MESSAGE_CHARS) throw AssistantErrors.messageTooLong(MAX_MESSAGE_CHARS);
  return cleaned;
}

export class AssistantController {
  constructor(
    private readonly chat: ChatService,
    private readonly store: ConversationStore,
    private readonly meta: ProviderMeta,
    private readonly options: ControllerOptions
  ) {}

  /** The conversation named in the URL, if it is the caller's; anything else is "not found" */
  private async own(req: Request): Promise<ConversationRecord> {
    const user = getAuthenticatedUser(req);
    const id = req.params.id;
    if (!UUID.test(id ?? '')) throw AssistantErrors.conversationNotFound();
    const conversation = await this.store.findConversation(user.id, id);
    if (!conversation) throw AssistantErrors.conversationNotFound();
    return conversation;
  }

  public readonly getMeta = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    res.json({
      success: true,
      data: { provider: this.meta.provider, ...(this.meta.model ? { model: this.meta.model } : {}), suggestions: suggestionsFor(user.role) },
    });
  });

  public readonly listConversations = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const items = await this.store.listConversations(user.id, CONVERSATION_LIST_LIMIT);
    res.json({ success: true, data: { items: items.map(summaryView) } });
  });

  public readonly createConversation = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const { title } = createSchema.parse(req.body ?? {});
    const conversation = await this.store.createConversation(user.id, title ?? null);
    res.status(201).json({ success: true, data: summaryView(conversation) });
  });

  public readonly getConversation = handle(async (req, res) => {
    const conversation = await this.own(req);
    const messages = await this.store.recentMessages(conversation.id, MESSAGE_PAGE_LIMIT);
    res.json({ success: true, data: { ...summaryView(conversation), messages: messages.map(messageView) } });
  });

  public readonly deleteConversation = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const id = req.params.id;
    if (!UUID.test(id ?? '') || !(await this.store.deleteConversation(user.id, id))) throw AssistantErrors.conversationNotFound();
    res.json({ success: true, data: { id, deleted: true } });
  });

  /**
   * The answer streams as text/event-stream unless the client prefers application/json. Everything that can be
   * refused (validation, ownership, the guardrails, storing the user's turn) happens before the first byte of the
   * stream, so refusals are ordinary JSON errors; once the stream is open, problems are reported in-band.
   */
  public readonly postMessage = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const content = parseContent(req.body);
    const conversation = await this.own(req);
    const admission = await this.chat.admit(user, req.log);
    const prepared = await this.chat.prepare(user, conversation, content);
    const controller = new AbortController();

    if (req.accepts(['text/event-stream', 'application/json']) === 'application/json') {
      // A client that leaves before the answer is done ends the turn (the owning services stop being called too)
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const outcome = await this.chat.answer(prepared, admission, { request: req, signal: controller.signal, sink: NO_SINK });
      if (outcome.failure) throw AssistantErrors.answerFailed(outcome.failure.code, outcome.failure.message);
      if (outcome.result === 'aborted') return;
      res.json({ success: true, data: messageView(outcome.message) });
      return;
    }

    const stream = openEventStream(req, res, { heartbeatMs: this.options.heartbeatMs });
    stream.onClose(() => controller.abort());
    const sink: TurnSink = {
      send: ({ type, ...data }: StreamEvent) => {
        stream.send(type, data);
      },
    };
    try {
      await this.chat.answer(prepared, admission, { request: req, signal: controller.signal, sink });
    } finally {
      stream.close();
    }
  });
}
