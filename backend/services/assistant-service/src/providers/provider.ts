import { AuthenticatedUser } from '@banksphere/common';
import { ToolRunner } from '../assistant/tool-runner';
import { ChatTurnMessage, ProviderKind, TokenUsage, TurnEvent } from '../assistant/types';
import { throwIfAborted } from '../assistant/errors';

/**
 * Something that answers one message: the OpenAI-compatible model or the built-in assistant. Both stream tokens
 * through `emit` and call tools through the same ToolRunner, so the client sees the same events either way.
 */
export interface TurnInput {
  user: AuthenticatedUser;
  /** Earlier messages of the conversation, oldest first (text only: no tool data is replayed) */
  history: ChatTurnMessage[];
  message: string;
  tools: ToolRunner;
  signal: AbortSignal;
  emit: (event: TurnEvent) => void;
  /** Tokens used so far; providers add to it as they go, so usage is known even when an answer fails */
  usage: TokenUsage;
  now: Date;
}

export interface AnswerProvider {
  readonly kind: ProviderKind;
  readonly model?: string;
  respond(input: TurnInput): Promise<{ content: string }>;
}

/**
 * Streams text word by word (each token keeps its trailing whitespace, so the tokens concatenate to the text).
 * A pause between words makes templated answers read like the model's; 0 just yields to the event loop.
 */
export async function streamWords(text: string, emit: (event: TurnEvent) => void, signal: AbortSignal, delayMs = 0): Promise<void> {
  const leading = /^\s*/.exec(text)![0];
  const words = text.slice(leading.length).match(/\S+\s*/g) ?? [];
  if (leading) words[0] = leading + (words[0] ?? '');
  for (const word of words) {
    throwIfAborted(signal);
    emit({ type: 'token', text: word });
    await pause(delayMs, signal);
  }
  throwIfAborted(signal);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      setImmediate(resolve);
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export const emptyUsage = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, estimated: false });
