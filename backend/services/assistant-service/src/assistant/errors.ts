/** The client went away (or pressed stop): every pending model and tool call is abandoned */
export class TurnAbortedError extends Error {
  readonly name = 'AbortError';
  constructor(message = 'The request was cancelled') {
    super(message);
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TurnAbortedError();
}

/** A failure of the model provider. Messages are ours, never the provider's body (it can echo customer data). */
export class LlmError extends Error {
  constructor(
    readonly code: 'LLM_TIMEOUT' | 'LLM_UNAVAILABLE' | 'LLM_REJECTED' | 'LLM_BAD_RESPONSE',
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
