import crypto from 'crypto';
import { AppendOptions, ConversationRecord, ConversationStore, MessageRecord, NewMessage } from '../../src/store/conversation-store';

/** ConversationStore over Maps, with the same owner scoping as the Prisma store */
export class MemoryConversationStore implements ConversationStore {
  public readonly conversations = new Map<string, ConversationRecord>();
  public readonly messages: MessageRecord[] = [];
  private tick = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Strictly increasing timestamps, so "newest first" is deterministic within one test */
  private stamp(): Date {
    return new Date(this.now().getTime() + this.tick++);
  }

  async listConversations(ownerId: string, limit: number) {
    return [...this.conversations.values()]
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async createConversation(ownerId: string, title: string | null) {
    const at = this.stamp();
    const conversation: ConversationRecord = { id: crypto.randomUUID(), ownerId, title, createdAt: at, updatedAt: at };
    this.conversations.set(conversation.id, conversation);
    return { ...conversation };
  }

  async findConversation(ownerId: string, id: string) {
    const conversation = this.conversations.get(id);
    return conversation && conversation.ownerId === ownerId ? { ...conversation } : null;
  }

  async deleteConversation(ownerId: string, id: string) {
    if (!(await this.findConversation(ownerId, id))) return false;
    this.conversations.delete(id);
    this.messages.splice(0, this.messages.length, ...this.messages.filter((m) => m.conversationId !== id));
    return true;
  }

  async recentMessages(conversationId: string, limit: number) {
    return this.messages.filter((m) => m.conversationId === conversationId).slice(-limit).map((m) => ({ ...m }));
  }

  async appendMessage(message: NewMessage, options: AppendOptions = {}) {
    const conversation = this.conversations.get(message.conversationId);
    if (!conversation) throw new Error(`no conversation ${message.conversationId}`);
    const record: MessageRecord = {
      id: message.id ?? crypto.randomUUID(),
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      cards: message.cards ?? [],
      toolNames: message.toolNames ?? [],
      promptTokens: message.promptTokens ?? 0,
      completionTokens: message.completionTokens ?? 0,
      provider: message.provider ?? null,
      model: message.model ?? null,
      latencyMs: message.latencyMs ?? null,
      status: message.status ?? 'complete',
      createdAt: this.stamp(),
    };
    this.messages.push(record);
    conversation.updatedAt = record.createdAt;
    if (!conversation.title && options.titleIfUnset) conversation.title = options.titleIfUnset;
    return { ...record };
  }

  async purgeConversations(cutoff: Date, limit: number) {
    const doomed = [...this.conversations.values()].filter((c) => c.updatedAt < cutoff).slice(0, limit);
    for (const c of doomed) await this.deleteConversation(c.ownerId, c.id);
    return doomed.length;
  }

  async acquireLease() {
    return true;
  }

  async releaseLease() {}

  async ping() {}
}
