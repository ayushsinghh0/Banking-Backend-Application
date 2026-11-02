import { Request } from 'express';
import { HttpError, ServiceUnavailableError } from '../errors/app-error';
import { INTERNAL_TOKEN_HEADER, readBearerToken } from '../middleware/authenticate.middleware';
import { histogram } from '../observability/metrics';
import { outgoingTraceparent } from '../observability/trace-context';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { retry } from '../resilience/retry';

export interface ServiceClientOptions {
  /** Upstream name for errors, metrics and the circuit breaker */
  name: string;
  baseUrl: string;
  /** Per-attempt timeout */
  timeoutMs?: number;
  /** Value of the service-to-service credential, sent as x-internal-service-token */
  internalToken?: string;
  /** Extra attempts for idempotent requests (GET/HEAD) after a connection error or 502/503/504 */
  retries?: number;
  /** false disables the breaker (e.g. for a client that is itself only used by a background job) */
  breaker?: CircuitBreaker | false;
  fetchImpl?: typeof fetch;
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /**
   * The request being handled: its correlation id, trace and client address are forwarded, and with
   * `forwardAuth` its bearer token too, so the upstream authorizes the original caller (never this service).
   */
  context?: Request;
  forwardAuth?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Unwrap the platform's `{ success, data }` envelope (default true) */
  envelope?: boolean;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const upstreamDuration = histogram('http_client_requests_seconds', 'Outgoing service-to-service request duration', [
  'upstream',
  'method',
  'outcome',
]);

class UpstreamTransientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null
  ) {
    super(message);
  }
}

/**
 * HTTP client for calls between services: timeouts on every attempt, retries with jitter for idempotent
 * methods only, a circuit breaker per upstream, and propagation of correlation id, W3C trace context and the
 * original client address. Upstream 4xx answers come back as HttpError with the upstream's code and message;
 * transport failures and 5xx become 503s (or the upstream's 503 with its Retry-After).
 */
export class ServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly breaker: CircuitBreaker | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retries = options.retries ?? 2;
    this.breaker = options.breaker === false ? null : (options.breaker ?? new CircuitBreaker({ name: options.name }));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public get<T>(path: string, options: Omit<CallOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  public post<T>(path: string, body?: unknown, options: Omit<CallOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  public patch<T>(path: string, body?: unknown, options: Omit<CallOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  public delete<T>(path: string, options: Omit<CallOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  public async request<T>(path: string, options: CallOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const idempotent = method === 'GET';
    const url = this.baseUrl + path + buildQuery(options.query);
    const headers = this.headers(options);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body, bigintToString);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const attempt = async (): Promise<T> => {
      const done = this.breaker?.acquire();
      if (this.breaker && !done) throw new ServiceUnavailableError(`${this.options.name} is temporarily unavailable`);
      const started = process.hrtime.bigint();
      let outcome = 'ok';
      try {
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        const response = await this.fetchImpl(url, {
          method,
          headers: { ...headers, 'x-request-deadline': String(Date.now() + timeoutMs) },
          body,
          signal,
        }).catch((error: unknown) => {
          // The caller gave up (its client went away): not the upstream's fault, and not worth a retry
          if (options.signal?.aborted) {
            outcome = 'cancelled';
            throw error;
          }
          outcome = isTimeout(error) ? 'timeout' : 'network';
          throw new UpstreamTransientError(`${this.options.name} ${outcome === 'timeout' ? 'timed out' : 'unreachable'}`);
        });

        if (RETRYABLE_STATUS.has(response.status) || response.status >= 500) {
          outcome = `http_${response.status}`;
          await response.body?.cancel().catch(() => undefined);
          throw new UpstreamTransientError(`${this.options.name} answered ${response.status}`, response.status, response.headers.get('retry-after'));
        }
        done?.(true);
        return await this.parse<T>(response, options.envelope !== false);
      } catch (error) {
        // Only transport failures and 5xx count against the upstream; its 4xx answers are healthy behaviour
        done?.(!(error instanceof UpstreamTransientError));
        throw error;
      } finally {
        upstreamDuration.observe(
          { upstream: this.options.name, method, outcome },
          Number(process.hrtime.bigint() - started) / 1e9
        );
      }
    };

    try {
      return await retry(attempt, {
        attempts: idempotent ? this.retries + 1 : 1,
        baseMs: 50,
        maxMs: 400,
        retryOn: (error) => error instanceof UpstreamTransientError && (error.status === undefined || RETRYABLE_STATUS.has(error.status)),
      });
    } catch (error) {
      if (error instanceof UpstreamTransientError) {
        const unavailable = new ServiceUnavailableError(`${this.options.name} is temporarily unavailable`);
        if (error.retryAfter) Object.assign(unavailable, { retryAfter: error.retryAfter });
        throw unavailable;
      }
      throw error;
    }
  }

  private headers(options: CallOptions): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.options.internalToken) headers[INTERNAL_TOKEN_HEADER] = this.options.internalToken;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const context = options.context;
    if (context) {
      if (context.correlationId) headers['x-correlation-id'] = context.correlationId;
      headers.traceparent = outgoingTraceparent(context);
      // Upstreams trust exactly one proxy hop, so this becomes their req.ip: per-client limits, staff network
      // checks and audit trails see the real client, not this service
      if (context.ip) headers['x-forwarded-for'] = context.ip;
      if (options.forwardAuth) {
        const token = readBearerToken(context);
        if (token) headers.authorization = `Bearer ${token}`;
      }
    } else {
      headers.traceparent = outgoingTraceparent(undefined);
    }
    return headers;
  }

  private async parse<T>(response: Response, envelope: boolean): Promise<T> {
    const text = await response.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError(502, 'BAD_GATEWAY', `${this.options.name} returned an invalid response`);
      }
    }
    if (!response.ok) {
      const error = json?.error;
      throw new HttpError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'UPSTREAM_ERROR',
        typeof error?.message === 'string' ? error.message : `${this.options.name} refused the request`
      );
    }
    if (!envelope) return json as T;
    return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
  }
}

function buildQuery(query: CallOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
