import { ServiceUnavailableError } from '../errors/app-error';
import { gauge } from '../observability/metrics';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Upstream name, used for the metric label and error messages */
  name: string;
  /** Rolling window over which the failure ratio is measured */
  windowMs?: number;
  /** The breaker never opens on fewer calls than this in the window (a single failure is not an outage) */
  minimumRequests?: number;
  /** Opens when failures / calls in the window reaches this */
  failureRatio?: number;
  /** How long it stays open before letting probes through */
  cooldownMs?: number;
  /** Probe calls in half-open; all must succeed to close again */
  halfOpenProbes?: number;
  now?: () => number;
}

const BUCKETS = 10;
const STATE_VALUE: Record<BreakerState, number> = { closed: 0, 'half-open': 1, open: 2 };
const stateGauge = gauge('circuit_breaker_state', 'Circuit breaker state (0 closed, 1 half-open, 2 open)', ['upstream']);

export class CircuitOpenError extends ServiceUnavailableError {
  constructor(upstream: string) {
    super(`${upstream} is temporarily unavailable`);
  }
}

/**
 * Stops calling an upstream that is failing, so a struggling service gets room to recover and callers fail in
 * microseconds instead of waiting out timeouts (which is what turns one slow service into a platform outage).
 *
 *   closed     calls flow; outcomes are counted in a rolling window of 10 buckets
 *   open       every call is refused until the cooldown has passed
 *   half-open  a few probe calls go through; all succeed -> closed, any fails -> open again
 *
 * `acquire()` returns a completion callback, or null when the call must not be made. Outcomes of calls that
 * started under an earlier state (generation) are ignored, so a slow call from before an outage can't close
 * or re-open the breaker on stale information.
 */
export class CircuitBreaker {
  private readonly opts: Required<Omit<CircuitBreakerOptions, 'now'>>;
  private readonly now: () => number;
  private currentState: BreakerState = 'closed';
  private generation = 0;
  private openedAt = 0;
  private probesStarted = 0;
  private probesSucceeded = 0;
  private readonly calls = new Array<number>(BUCKETS).fill(0);
  private readonly failures = new Array<number>(BUCKETS).fill(0);
  private bucketStart = 0;
  private bucketIndex = 0;

  constructor(options: CircuitBreakerOptions) {
    this.opts = {
      name: options.name,
      windowMs: options.windowMs ?? 10_000,
      minimumRequests: options.minimumRequests ?? 20,
      failureRatio: options.failureRatio ?? 0.5,
      cooldownMs: options.cooldownMs ?? 5_000,
      halfOpenProbes: options.halfOpenProbes ?? 3,
    };
    this.now = options.now ?? Date.now;
    this.bucketStart = this.now();
    stateGauge.set({ upstream: this.opts.name }, 0);
  }

  public get state(): BreakerState {
    if (this.currentState === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.transition('half-open');
    }
    return this.currentState;
  }

  public get name(): string {
    return this.opts.name;
  }

  /** Permission to make one call: a callback to report its outcome, or null if the breaker refuses */
  public acquire(): ((success: boolean) => void) | null {
    const state = this.state;
    if (state === 'open') return null;
    if (state === 'half-open') {
      if (this.probesStarted >= this.opts.halfOpenProbes) return null;
      this.probesStarted += 1;
    }
    const generation = this.generation;
    let reported = false;
    return (success: boolean) => {
      if (reported) return;
      reported = true;
      if (generation !== this.generation) return;
      this.record(success);
    };
  }

  /** Runs `fn` through the breaker; `isFailure` decides which outcomes count against the upstream */
  public async execute<T>(fn: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true): Promise<T> {
    const done = this.acquire();
    if (!done) throw new CircuitOpenError(this.opts.name);
    try {
      const result = await fn();
      done(true);
      return result;
    } catch (error) {
      done(!isFailure(error));
      throw error;
    }
  }

  private record(success: boolean): void {
    if (this.currentState === 'half-open') {
      if (!success) {
        this.transition('open');
        return;
      }
      this.probesSucceeded += 1;
      if (this.probesSucceeded >= this.opts.halfOpenProbes) this.transition('closed');
      return;
    }
    this.rotate();
    this.calls[this.bucketIndex] += 1;
    if (!success) this.failures[this.bucketIndex] += 1;
    const calls = this.sum(this.calls);
    if (calls >= this.opts.minimumRequests && this.sum(this.failures) / calls >= this.opts.failureRatio) {
      this.transition('open');
    }
  }

  private transition(next: BreakerState): void {
    this.currentState = next;
    this.generation += 1;
    this.probesStarted = 0;
    this.probesSucceeded = 0;
    if (next === 'open') this.openedAt = this.now();
    if (next === 'closed') {
      this.calls.fill(0);
      this.failures.fill(0);
      this.bucketStart = this.now();
    }
    stateGauge.set({ upstream: this.opts.name }, STATE_VALUE[next]);
  }

  /** Advances the rolling window, clearing buckets that have aged out */
  private rotate(): void {
    const bucketMs = this.opts.windowMs / BUCKETS;
    const elapsed = Math.floor((this.now() - this.bucketStart) / bucketMs);
    if (elapsed <= 0) return;
    for (let i = 0; i < Math.min(elapsed, BUCKETS); i++) {
      this.bucketIndex = (this.bucketIndex + 1) % BUCKETS;
      this.calls[this.bucketIndex] = 0;
      this.failures[this.bucketIndex] = 0;
    }
    this.bucketStart += elapsed * bucketMs;
  }

  private sum(values: number[]): number {
    return values.reduce((total, v) => total + v, 0);
  }
}
