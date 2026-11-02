import net from 'net';
import dotenv from 'dotenv';
import { Request, Response } from 'express';
import {
  RedisTokenStateStore,
  TokenStateStore,
  assertJwtVerificationConfigured,
  assertNoPlaceholders,
  connectRedis,
  createAuthenticate,
  createBaseApp,
  errorHandlerMiddleware,
  isSwaggerEnabled,
  logger,
  notFoundHandler,
  prismaClientOptions,
  setupSwagger,
  startHttpServer,
} from '@banksphere/common';
import { PrismaClient } from '../generated/client';
import { AssistantConfig, envInt, loadConfig } from './config';
import { AssistantController } from './controllers/assistant.controller';
import { MemoryTurnLimits, RedisTurnLimits, TurnLimits } from './guardrails/limits';
import { buildArticles } from './knowledge/articles';
import { BuiltinProvider } from './providers/builtin-provider';
import { OpenAICompatibleProvider } from './providers/openai-provider';
import { AnswerProvider } from './providers/provider';
import { createAssistantRouter } from './routes/assistant.routes';
import { ChatService } from './services/chat.service';
import { RetentionJob, RetentionOptions } from './services/retention';
import { ConversationStore } from './store/conversation-store';
import { PrismaConversationStore } from './store/prisma-conversation-store';
import { HttpBankingApi } from './tools/banking-api';
import { ToolSpec, createTools } from './tools/tools';

export const ASSISTANT_PREFIX = '/api/v1/assistant';

export interface AssistantAppDeps {
  config: Pick<AssistantConfig, 'historyMessages' | 'retentionDays'>;
  store: ConversationStore;
  tools: readonly ToolSpec[];
  /** The model when LLM_API_KEY is set, otherwise the built-in assistant */
  provider: AnswerProvider;
  /** The built-in assistant, which answers when the model can't */
  fallback: AnswerProvider;
  limits: TurnLimits;
  tokenState: TokenStateStore;
  /** Readiness also needs the security Redis (token state) */
  health?: { securityRedis?: { ping(): Promise<unknown> } };
  /** Defaults to STAFF_ALLOWED_CIDRS */
  staffNetworks?: net.BlockList | null;
  now?: () => Date;
  heartbeatMs?: number;
  retention?: Partial<Omit<RetentionOptions, 'retentionDays' | 'now'>>;
}

export function createApp(deps: AssistantAppDeps) {
  assertJwtVerificationConfigured();
  const now = deps.now ?? (() => new Date());
  const app = createBaseApp();

  const chat = new ChatService({
    store: deps.store,
    tools: deps.tools,
    provider: deps.provider,
    fallback: deps.fallback,
    limits: deps.limits,
    historyMessages: deps.config.historyMessages,
    now,
  });
  const controller = new AssistantController(
    chat,
    deps.store,
    { provider: deps.provider.kind, ...(deps.provider.model ? { model: deps.provider.model } : {}) },
    { heartbeatMs: deps.heartbeatMs ?? 15_000 }
  );
  // createAuthenticate also refuses staff tokens from outside STAFF_ALLOWED_CIDRS and staff without MFA
  const authenticate = createAuthenticate(deps.tokenState, deps.staffNetworks !== undefined ? { staffNetworks: deps.staffNetworks } : {});
  app.use(ASSISTANT_PREFIX, createAssistantRouter(controller, authenticate));

  if (isSwaggerEnabled()) {
    setupSwagger(app, {
      title: 'BankSphere - Sphere assistant',
      version: '1.0.0',
      description: 'Read-only banking assistant: conversations, and answers streamed as Server-Sent Events with structured cards',
      paths: {
        [`${ASSISTANT_PREFIX}/meta`]: { get: { summary: '{ provider: llm|builtin, model?, suggestions[] } for the signed-in role' } },
        [`${ASSISTANT_PREFIX}/conversations`]: {
          get: { summary: 'The caller’s newest 20 conversations' },
          post: { summary: 'Start a conversation: { title? }' },
        },
        [`${ASSISTANT_PREFIX}/conversations/{id}`]: {
          get: { summary: 'One of the caller’s conversations with its messages (others are 404)' },
          delete: { summary: 'Delete one of the caller’s conversations' },
        },
        [`${ASSISTANT_PREFIX}/conversations/{id}/messages`]: {
          post: {
            summary:
              '{ content } (1-2000 chars). text/event-stream: message.start, tool.call, tool.result, token, message.end or error. With Accept: application/json the final message. 429 RATE_LIMIT_EXCEEDED / TOKEN_BUDGET_EXCEEDED.',
          },
        },
      },
    });
  }

  // Readiness: the database and the token-state Redis (without it every request is refused)
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await deps.store.ping();
      if (deps.health?.securityRedis) await deps.health.securityRedis.ping();
      res.json({ status: 'UP', service: 'assistant-service', provider: deps.provider.kind, timestamp: new Date().toISOString() });
    } catch (err) {
      req.log.error({ err }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', service: 'assistant-service' });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandlerMiddleware);

  const retention = new RetentionJob(deps.store, { retentionDays: deps.config.retentionDays, now, ...deps.retention });
  return { app, chat, retention };
}

async function main(): Promise<void> {
  dotenv.config();
  assertNoPlaceholders(['DATABASE_URL', 'REDIS_URL', 'CACHE_REDIS_URL', 'JWT_VERIFY_KEYS', 'LLM_API_KEY']);
  // Everything is validated before anything starts: a bad value stops the service here
  const config = loadConfig();
  const cacheRedisUrl = process.env.CACHE_REDIS_URL;
  if (!cacheRedisUrl && process.env.NODE_ENV === 'production') {
    throw new Error('CACHE_REDIS_URL must be set in production (the cache Redis, ACL user assistant-svc): message limits and token budgets are shared across replicas');
  }
  const retentionIntervalMs = envInt(process.env, 'ASSISTANT_RETENTION_INTERVAL_MS', 3_600_000, 60_000);

  const prisma = new PrismaClient(prismaClientOptions());
  const securityRedis = await connectRedis(); // REDIS_URL: read-only token state
  const cacheRedis = cacheRedisUrl ? await connectRedis(cacheRedisUrl) : null;
  const limitSettings = { rate: config.rate, dailyTokenBudget: config.dailyTokenBudget };
  const limits = cacheRedis ? new RedisTurnLimits(cacheRedis, limitSettings) : new MemoryTurnLimits(limitSettings);
  if (!cacheRedis) logger.warn('CACHE_REDIS_URL is not set: message limits and token budgets are kept in memory (one replica only)');

  const articles = buildArticles(config.policy);
  const tools = createTools({ api: new HttpBankingApi(config.upstream), articles, policy: config.policy });
  const builtin = new BuiltinProvider({ articles, wordDelayMs: config.builtinWordDelayMs });
  const provider = config.llm ? new OpenAICompatibleProvider(config.llm) : builtin;

  const { app, retention } = createApp({
    config,
    store: new PrismaConversationStore(prisma),
    tools,
    provider,
    fallback: builtin,
    limits,
    tokenState: new RedisTokenStateStore(securityRedis),
    health: { securityRedis },
  });
  // Never the key: which engine answers, the model and the provider's host only
  logger.info(
    { provider: provider.kind, ...(config.llm ? { model: config.llm.model, llmHost: new URL(config.llm.baseUrl).host } : {}), retentionDays: config.retentionDays },
    'Sphere assistant configured'
  );
  const stopRetention = retention.start(retentionIntervalMs);

  startHttpServer(app, process.env.PORT || 8008, 'assistant-service', [
    stopRetention,
    () => prisma.$disconnect(),
    () => securityRedis.quit(),
    () => cacheRedis?.quit(),
  ]);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'assistant-service failed to start');
    process.exit(1);
  });
}
