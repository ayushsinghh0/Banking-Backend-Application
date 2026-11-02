import { Card, ProviderKind } from '../assistant/types';

/**
 * Persistence for chat threads (assistant_schema: conversations, messages, job_leases). Every read and write of a
 * conversation is scoped to its owner, so another user's thread is indistinguishable from one that doesn't exist.
 * Messages are written once: the user's turn, then the assistant's answer with how it was produced.
 */
export type MessageRole = 'user' | 'assistant';

/** complete: the answer finished; interrupted: the client left or stopped it; failed: the provider broke mid-answer */
export type MessageStatus = 'complete' | 'interrupted' | 'failed';

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: Date;
}

export interface ConversationRecord extends ConversationSummary {
  ownerId: string;
  createdAt: Date;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** The structured blocks the user was shown (never the tool data itself) */
  cards: Card[];
  toolNames: string[];
  promptTokens: number;
  completionTokens: number;
  provider: ProviderKind | null;
  model: string | null;
  latencyMs: number | null;
  status: MessageStatus;
  createdAt: Date;
}

export interface NewMessage {
  /** Chosen before the answer starts, so the client learns it in message.start before the row exists */
  id?: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  cards?: Card[];
  toolNames?: string[];
  promptTokens?: number;
  completionTokens?: number;
  provider?: ProviderKind | null;
  model?: string | null;
  latencyMs?: number | null;
  status?: MessageStatus;
}

export interface AppendOptions {
  /** Names an untitled conversation after its first message */
  titleIfUnset?: string;
}

export interface ConversationStore {
  /** Newest first */
  listConversations(ownerId: string, limit: number): Promise<ConversationSummary[]>;
  createConversation(ownerId: string, title: string | null): Promise<ConversationRecord>;
  /** null for a missing conversation and for someone else's alike */
  findConversation(ownerId: string, id: string): Promise<ConversationRecord | null>;
  /** false when there is nothing of this owner's to delete */
  deleteConversation(ownerId: string, id: string): Promise<boolean>;
  /** The last `limit` messages of a conversation, oldest first */
  recentMessages(conversationId: string, limit: number): Promise<MessageRecord[]>;
  /** Appends the message and marks the conversation as updated */
  appendMessage(message: NewMessage, options?: AppendOptions): Promise<MessageRecord>;
  /** Deletes up to `limit` conversations (with their messages) not updated since `cutoff`; returns how many */
  purgeConversations(cutoff: Date, limit: number): Promise<number>;
  acquireLease(name: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(name: string): Promise<void>;
  ping(): Promise<void>;
}
