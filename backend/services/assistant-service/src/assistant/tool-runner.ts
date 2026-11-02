import { Logger } from '@banksphere/common';
import { ToolContext } from '../tools/banking-api';
import { ToolOutcome, ToolSpec } from '../tools/tools';
import { toolCallsTotal } from '../metrics';
import { TurnAbortedError } from './errors';
import { Card, ToolName, TurnEvent } from './types';

/** Tool calls one answer may make in total, across all rounds */
export const MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * Runs tools for one answer, for whichever provider is answering, so both produce the same events and cards:
 * `tool.call {name, label}`, then `tool.result {name, card}` (card null when there is nothing to show). Only the
 * tools allowed for the user's role can run; anything else is refused without contacting any service.
 */
export class ToolRunner {
  readonly cards: Card[] = [];
  readonly toolNames: ToolName[] = [];
  private calls = 0;
  private readonly byName: Map<string, ToolSpec>;

  constructor(
    tools: readonly ToolSpec[],
    private readonly ctx: ToolContext,
    private readonly emit: (event: TurnEvent) => void,
    private readonly log: Logger
  ) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  public get available(): ToolSpec[] {
    return [...this.byName.values()];
  }

  public has(name: string): boolean {
    return this.byName.has(name);
  }

  /** OpenAI-style function definitions of the allowed tools */
  public definitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.available.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  public async run(name: string, rawArgs: unknown): Promise<ToolOutcome> {
    if (this.ctx.signal.aborted) throw new TurnAbortedError();
    const tool = this.byName.get(name);
    if (!tool) {
      // Unknown names come from the model: one bounded metric label for all of them
      toolCallsTotal.inc({ tool: 'unknown', result: 'rejected' });
      return { ok: false, code: 'INVALID', error: `There is no tool called ${JSON.stringify(name.slice(0, 40))} available here.` };
    }
    if (this.calls >= MAX_TOOL_CALLS_PER_TURN) {
      toolCallsTotal.inc({ tool: tool.name, result: 'rejected' });
      return { ok: false, code: 'INVALID', error: 'The tool call limit for this answer is reached. Answer with the data you already have.' };
    }
    const parsed = tool.args.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      toolCallsTotal.inc({ tool: tool.name, result: 'invalid' });
      return {
        ok: false,
        code: 'INVALID',
        error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}`.slice(0, 300),
      };
    }

    this.calls++;
    this.emit({ type: 'tool.call', name: tool.name, label: tool.label });
    const started = Date.now();
    let outcome: ToolOutcome;
    try {
      outcome = await tool.run(parsed.data, this.ctx);
    } catch (error) {
      if (error instanceof TurnAbortedError || this.ctx.signal.aborted) throw new TurnAbortedError();
      // A bug in a tool must not break the answer: the model (or template) gets a friendly failure
      this.log.error({ err: error, tool: tool.name }, 'Assistant tool failed unexpectedly');
      outcome = { ok: false, code: 'UNAVAILABLE', error: 'Something went wrong while looking that up. Please try again.' };
    }
    if (this.ctx.signal.aborted) throw new TurnAbortedError();

    this.toolNames.push(tool.name);
    const card = outcome.ok ? outcome.card : null;
    if (card) this.cards.push(card);
    toolCallsTotal.inc({ tool: tool.name, result: outcome.ok ? 'ok' : 'error' });
    this.log.info(
      { tool: tool.name, ok: outcome.ok, ...(!outcome.ok && { code: outcome.code, upstreamStatus: outcome.status }), latencyMs: Date.now() - started },
      'Assistant tool call'
    );
    this.emit({ type: 'tool.result', name: tool.name, card });
    return outcome;
  }
}

