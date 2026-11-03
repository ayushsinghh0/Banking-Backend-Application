import { counter, histogram } from '@banksphere/common';

/** result: ok | fallback (the model failed before answering; the built-in assistant answered) | budget_exhausted | aborted | error */
export const messagesTotal = counter('assistant_messages_total', 'Assistant answers by provider and result', ['provider', 'result']);

/** direction: prompt | completion (estimated from text length when the provider doesn't report usage) */
export const llmTokensTotal = counter('assistant_llm_tokens_total', 'Tokens used with the model provider', ['direction']);

/** result: ok | error (friendly failure from the owning service) | invalid (bad arguments) | rejected (not allowed or over the cap) */
export const toolCallsTotal = counter('assistant_tool_calls_total', 'Assistant tool calls by tool and result', ['tool', 'result']);

export const responseSeconds = histogram(
  'assistant_response_seconds',
  'Time from receiving a message to the end of the answer',
  ['provider', 'result'],
  [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60]
);

/** result: ok | skipped (another replica holds the lease) | error */
export const retentionRuns = counter('assistant_retention_runs_total', 'Retention job runs by result', ['result']);

export const conversationsPurged = counter('assistant_conversations_purged_total', 'Conversations deleted after the retention period');
