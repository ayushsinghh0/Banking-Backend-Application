/**
 * The contract between the assistant and the web app (design section 7). Cards are structured data the app draws;
 * they never contain markup, and the app validates every field again before showing it.
 */
export type TopUpStatus =
  | 'CREATED'
  | 'PENDING'
  | 'CAPTURED'
  | 'CREDITED'
  | 'CREDIT_BLOCKED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED';

export type Card =
  | { type: 'accounts'; accounts: Array<{ id: string; label: string; last4: string; balancePaise: string }> }
  | {
      type: 'transactions';
      accountLabel: string;
      items: Array<{ id: string; at: string; description: string; direction: 'CREDIT' | 'DEBIT'; amountPaise: string }>;
    }
  | { type: 'spending'; days: number; inPaise: string; outPaise: string; byDay: Array<{ date: string; inPaise: string; outPaise: string }> }
  | { type: 'payees'; items: Array<{ nickname: string; last4: string; active: boolean }> }
  | { type: 'topups'; items: Array<{ id: string; amountPaise: string; status: TopUpStatus; at: string }> }
  | { type: 'transferDraft'; fromAccountId: string; toPayeeNickname?: string; amountPaise?: string; note?: string }
  | { type: 'help'; title: string; steps: string[] };

export const TOOL_NAMES = [
  'list_accounts',
  'recent_transactions',
  'spending_summary',
  'list_payees',
  'list_top_ups',
  'explain_limits',
  'draft_transfer',
  'search_help',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** What a provider streams while it answers (message.start / message.end / error are added by the chat service) */
export type TurnEvent =
  | { type: 'tool.call'; name: ToolName; label: string }
  | { type: 'tool.result'; name: ToolName; card: Card | null }
  | { type: 'token'; text: string };

/** Everything the client receives, in order */
export type StreamEvent =
  | { type: 'message.start'; messageId: string }
  | TurnEvent
  | { type: 'message.end'; messageId: string }
  | { type: 'error'; code: string; message: string };

export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** The provider didn't report usage; the counts are estimated from text length */
  estimated: boolean;
}

export type ProviderKind = 'llm' | 'builtin';
