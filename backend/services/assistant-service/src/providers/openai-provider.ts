import { LlmConfig } from '../config';
import { LlmError, TurnAbortedError } from '../assistant/errors';
import { ToolOutcome } from '../tools/tools';
import { AnswerProvider, TurnInput } from './provider';
import { buildSystemPrompt } from './prompt';
import { readSse } from './sse-reader';

/** Rounds in which the model may call tools; one more request then has to answer from what it has */
export const MAX_TOOL_ROUNDS = 4;
/** Tool calls the model may make in one round; extra calls are answered with an error, not run */
export const MAX_TOOL_CALLS_PER_ROUND = 5;
const MAX_ARGUMENT_CHARS = 8_000;
const MAX_HISTORY_CHARS = 2_000;

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface Completion {
  content: string;
  toolCalls: ToolCall[];
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Any OpenAI-compatible chat completions API (OpenAI, Groq, OpenRouter, a local Ollama): streamed answers with
 * tool calling. Each request has its own timeout; a stream that breaks halfway is never retried (the customer has
 * already seen part of it). The provider's error bodies are never logged or shown: they can echo customer data.
 */
export class OpenAICompatibleProvider implements AnswerProvider {
  readonly kind = 'llm' as const;
  private readonly url: string;

  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  get model(): string {
    return this.config.model;
  }

  public async respond(input: TurnInput): Promise<{ content: string }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(input.user, input.now) },
      ...input.history.map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }) as ChatMessage),
      { role: 'user', content: input.message },
    ];
    const tools = input.tools.definitions();

    let content = '';
    let separate = false;
    const onToken = (text: string) => {
      // Text the model wrote before calling tools ("Let me check...") is followed by a paragraph break
      if (separate && content) {
        content += '\n\n';
        input.emit({ type: 'token', text: '\n\n' });
      }
      separate = false;
      content += text;
      input.emit({ type: 'token', text });
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const toolsAllowed = tools.length > 0 && round < MAX_TOOL_ROUNDS;
      const completion = await this.complete(messages, tools, toolsAllowed, input, onToken);
      // After the last tool round the model must answer; tool calls it still makes are ignored
      if (!toolsAllowed || !completion.toolCalls.length) break;

      messages.push({
        role: 'assistant',
        content: completion.content || null,
        tool_calls: completion.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const [index, call] of completion.toolCalls.entries()) {
        let outcome: ToolOutcome;
        if (index >= MAX_TOOL_CALLS_PER_ROUND) {
          outcome = { ok: false, code: 'INVALID', error: 'Too many tool calls at once. Use the results you already have.' };
        } else {
          const args = parseArguments(call.arguments);
          outcome = args.ok ? await input.tools.run(call.name, args.value) : { ok: false, code: 'INVALID', error: 'The arguments were not valid JSON.' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessage(outcome) });
      }
      if (completion.content) separate = true;
    }

    if (!content.trim()) {
      onToken(input.tools.cards.length ? 'Here’s what I found.' : 'Sorry, I couldn’t put an answer together. Please try asking in a different way.');
    }
    return { content };
  }

  private async complete(
    messages: ChatMessage[],
    tools: ReturnType<TurnInput['tools']['definitions']>,
    toolsAllowed: boolean,
    input: TurnInput,
    onToken: (text: string) => void
  ): Promise<Completion> {
    const body = {
      model: this.config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      ...(tools.length && { tools, tool_choice: toolsAllowed ? 'auto' : 'none' }),
    };
    const payload = JSON.stringify(body);
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const fail = (error: unknown): Error => {
      if (error instanceof LlmError) return error;
      if (input.signal.aborted) return new TurnAbortedError();
      if (timeout.aborted) return new LlmError('LLM_TIMEOUT', 'The model provider did not answer in time');
      return new LlmError('LLM_UNAVAILABLE', 'The model provider could not be reached');
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: payload,
        signal,
      });
    } catch (error) {
      throw fail(error);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      // 4xx other than 408/429 means our request or key is wrong (configuration); the rest is the provider's state
      const rejected = status >= 400 && status < 500 && status !== 408 && status !== 429;
      throw new LlmError(rejected ? 'LLM_REJECTED' : 'LLM_UNAVAILABLE', `The model provider answered ${status}`, status);
    }

    const result: Completion = { content: '', toolCalls: [] };
    const calls = new Map<number, ToolCall>();
    let usage: { prompt: number; completion: number } | null = null;
    try {
      for await (const message of readSse(response.body, signal)) {
        if (message.data.trim() === '[DONE]') break;
        let chunk: any;
        try {
          chunk = JSON.parse(message.data);
        } catch {
          throw new LlmError('LLM_BAD_RESPONSE', 'The model provider sent an unreadable stream');
        }
        if (message.event === 'error' || chunk?.error) throw new LlmError('LLM_UNAVAILABLE', 'The model provider reported an error mid-answer');
        if (chunk?.usage && typeof chunk.usage === 'object') {
          usage = { prompt: Number(chunk.usage.prompt_tokens) || 0, completion: Number(chunk.usage.completion_tokens) || 0 };
        }
        for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
          if ((choice?.index ?? 0) !== 0) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            result.content += delta.content;
            onToken(delta.content);
          }
          for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            // Tool calls stream in pieces, matched by index: id and name first, then the arguments in fragments
            const index = Number.isInteger(part?.index) ? part.index : 0;
            const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
            calls.set(index, call);
            if (typeof part.id === 'string' && part.id) call.id = part.id;
            const name = part.function?.name;
            if (typeof name === 'string' && name && name !== call.name) call.name += name;
            if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
            if (call.arguments.length > MAX_ARGUMENT_CHARS) throw new LlmError('LLM_BAD_RESPONSE', 'The model sent oversized tool arguments');
          }
        }
      }
      if (signal.aborted) throw fail(signal.reason);
    } catch (error) {
      throw fail(error);
    } finally {
      // Charged whether or not the stream finished: the provider did the work
      const argumentText = [...calls.values()].map((c) => c.name + c.arguments).join('');
      if (usage) {
        input.usage.promptTokens += usage.prompt;
        input.usage.completionTokens += usage.completion;
      } else {
        input.usage.promptTokens += estimateTokens(payload);
        input.usage.completionTokens += estimateTokens(result.content + argumentText);
        input.usage.estimated = true;
      }
    }

    result.toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}_${Date.now().toString(36)}` }))
      .filter((call) => call.name);
    return result;
  }
}

function parseArguments(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** What the model sees from a tool: data (or a friendly error), labelled as data */
function toolMessage(outcome: ToolOutcome): string {
  return JSON.stringify(outcome.ok ? { ok: true, data: outcome.data } : { ok: false, error: outcome.error });
}
