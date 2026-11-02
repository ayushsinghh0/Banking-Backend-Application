import { INSTANCE_ID, acquireJobLease } from '@banksphere/common';
import { Message as MessageRow, Prisma, PrismaClient } from '../../generated/client';
import { Card } from '../assistant/types';
import { AppendOptions, ConversationRecord, ConversationStore, ConversationSummary, MessageRecord, NewMessage } from './conversation-store';

/** A messages row is exactly a MessageRecord once the JSON column is typed */
function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    cards: Array.isArray(row.cards) ? (row.cards as unknown as Card[]) : [],
    toolNames: row.toolNames,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latencyMs,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export class PrismaConversationStore implements ConversationStore {
  constructor(private readonly prisma: PrismaClient) {}

  public listConversations(ownerId: string, limit: number): Promise<ConversationSummary[]> {
    return this.prisma.conversation.findMany({
      where: { ownerId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, title: true, updatedAt: true },
    });
  }

  public createConversation(ownerId: string, title: string | null): Promise<ConversationRecord> {
    return this.prisma.conversation.create({ data: { ownerId, title } });
  }

  public findConversation(ownerId: string, id: string): Promise<ConversationRecord | null> {
    return this.prisma.conversation.findFirst({ where: { id, ownerId } });
  }

  public async deleteConversation(ownerId: string, id: string): Promise<boolean> {
    // The owner is part of the WHERE, so a guessed id of someone else's thread deletes nothing
    const { count } = await this.prisma.conversation.deleteMany({ where: { id, ownerId } });
    return count === 1;
  }

  public async recentMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map(toMessage);
  }

  public appendMessage(message: NewMessage, options: AppendOptions = {}): Promise<MessageRecord> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.message.create({
        data: {
          ...(message.id ? { id: message.id } : {}),
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          cards: (message.cards ?? []) as unknown as Prisma.InputJsonValue,
          toolNames: message.toolNames ?? [],
          promptTokens: message.promptTokens ?? 0,
          completionTokens: message.completionTokens ?? 0,
          provider: message.provider ?? null,
          model: message.model ?? null,
          latencyMs: message.latencyMs ?? null,
          status: message.status ?? 'complete',
        },
      });
      // updated_at orders the list and drives retention; it moves with every message, never on its own
      await tx.conversation.update({ where: { id: message.conversationId }, data: { updatedAt: row.createdAt } });
      if (options.titleIfUnset) {
        await tx.conversation.updateMany({ where: { id: message.conversationId, title: null }, data: { title: options.titleIfUnset } });
      }
      return toMessage(row);
    });
  }

  public async purgeConversations(cutoff: Date, limit: number): Promise<number> {
    // Oldest first, in bounded batches, so one run never takes a long lock on a large table
    const stale = await this.prisma.conversation.findMany({
      where: { updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (!stale.length) return 0;
    const { count } = await this.prisma.conversation.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
    return count;
  }

  public acquireLease(name: string, ttlSeconds: number): Promise<boolean> {
    return acquireJobLease(this.prisma, name, ttlSeconds);
  }

  public async releaseLease(name: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = ${name} AND holder = ${INSTANCE_ID}
    `;
  }

  public async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
