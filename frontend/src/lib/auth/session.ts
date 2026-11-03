import { ApiError } from '@/lib/api/errors';
import { SESSION_TRANSPORT_HEADER } from '@/lib/api/client';

export const ROLES = ['CUSTOMER', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'SUPPORT', 'BANK_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
export type StaffRole = Exclude<Role, 'CUSTOMER'>;

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  /** The session was established (or upgraded) with the second factor */
  mfa: boolean;
  sessionId?: string;
  /** Unix seconds of the last TOTP verification that issued this token */
  stepUpAt?: number;
  /** Unix seconds when the current authenticator was enrolled */
  mfaSince?: number;
  /** Unix seconds */
  expiresAt: number;
}

export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous';

/** The server accepts a step-up for 300 s; ask again a little earlier so a request in flight doesn't race it */
const STEP_UP_WINDOW_SECONDS = 270;
const PROACTIVE_REFRESH_LEAD_MS = 60_000;
const CONCURRENT_REFRESH_RETRY_MS = 750;
const REFRESH_LOCK = 'banksphere:session-refresh';

function decodeSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Reads the identity claims of an access token. Display and routing only: the API verifies every token. */
export function decodeAccessToken(token: string): SessionUser | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = decodeSegment(parts[1]) as Record<string, unknown>;
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.email !== 'string' ||
      typeof claims.exp !== 'number' ||
      !ROLES.includes(claims.role as Role)
    ) {
      return null;
    }
    return {
      id: claims.sub,
      email: claims.email,
      role: claims.role as Role,
      mfa: claims.mfa === true,
      sessionId: typeof claims.sessionId === 'string' ? claims.sessionId : undefined,
      stepUpAt: typeof claims.stepUpAt === 'number' ? claims.stepUpAt : undefined,
      mfaSince: typeof claims.mfaSince === 'number' ? claims.mfaSince : undefined,
      expiresAt: claims.exp,
    };
  } catch {
    return null;
  }
}

export function hasFreshStepUp(
  user: Pick<SessionUser, 'mfa' | 'stepUpAt'> | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  return Boolean(user?.mfa && user.stepUpAt !== undefined && nowSeconds - user.stepUpAt <= STEP_UP_WINDOW_SECONDS);
}

export const isStaffRole = (role: Role | undefined): role is StaffRole => Boolean(role && role !== 'CUSTOMER');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SessionStoreOptions {
  baseUrl?: string;
  channelName?: string;
}

type Listener = () => void;

/**
 * Holds the access token in memory only. The refresh token lives in an HttpOnly, SameSite=Strict cookie the
 * page can never read; renewing the access token is a POST that the browser authenticates with that cookie.
 */
export class SessionStore {
  private accessToken: string | null = null;
  private currentUser: SessionUser | null = null;
  private currentStatus: SessionStatus = 'unknown';
  private readonly listeners = new Set<Listener>();
  private inflight: Promise<string | null> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly channel: BroadcastChannel | null;
  private readonly baseUrl: string;

  constructor(options: SessionStoreOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/v1';
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(options.channelName ?? 'banksphere-session');
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent) => {
        if (event.data === 'logout') this.clear(false);
      };
    }
  }

  get status(): SessionStatus {
    return this.currentStatus;
  }

  get user(): SessionUser | null {
    return this.currentUser;
  }

  getAccessToken = (): string | null => this.accessToken;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setAccessToken(token: string): void {
    const user = decodeAccessToken(token);
    if (!user) {
      this.clear(false);
      return;
    }
    this.accessToken = token;
    this.currentUser = user;
    this.currentStatus = 'authenticated';
    this.scheduleRefresh(user.expiresAt);
    this.emit();
  }

  /** Called once at start-up: an existing cookie session signs the user straight back in */
  async restore(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // Server unreachable: show the sign-in page rather than a spinner forever
      if (this.currentStatus === 'unknown') this.clear(false);
    }
  }

  /**
   * Renews the access token. Resolves null when the session is over (sign in again); rejects with an
   * ApiError on transient failures (offline, 5xx) so a flaky network never signs anyone out.
   */
  refresh(): Promise<string | null> {
    this.inflight ??= this.withCrossTabLock(() => this.requestRefresh()).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async logout(): Promise<void> {
    const token = this.accessToken;
    try {
      await fetch(`${this.baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SESSION_TRANSPORT_HEADER]: 'cookie',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: '{}',
        credentials: 'same-origin',
      });
    } catch {
      // The cookie expires on its own; local sign-out must still happen
    }
    this.clear(true);
  }

  /** Drops the session locally (e.g. after a password change signed every session out) */
  clear(broadcast: boolean): void {
    this.accessToken = null;
    this.currentUser = null;
    this.currentStatus = 'anonymous';
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (broadcast) this.channel?.postMessage('logout');
    this.emit();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.channel?.close();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleRefresh(expiresAtSeconds: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(expiresAtSeconds * 1000 - Date.now() - PROACTIVE_REFRESH_LEAD_MS, 5_000);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch(() => {
        // Retried on the next API call that gets a 401
      });
    }, delay);
  }

  private async withCrossTabLock<T>(work: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) return work();
    return locks.request(REFRESH_LOCK, work) as Promise<T>;
  }

  private async requestRefresh(attempt = 1): Promise<string | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', [SESSION_TRANSPORT_HEADER]: 'cookie' },
        body: '{}',
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Network request failed' });
    }

    if (response.ok) {
      const body = (await response.json()) as { data?: { accessToken?: string } };
      const token = body.data?.accessToken;
      if (!token) {
        this.clear(false);
        return null;
      }
      this.setAccessToken(token);
      return token;
    }

    let code = '';
    try {
      code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? '';
    } catch {
      code = '';
    }
    if (response.status === 409 && code === 'REFRESH_IN_PROGRESS' && attempt === 1) {
      // Another tab rotated the cookie a moment ago; the browser now holds the new one
      await sleep(CONCURRENT_REFRESH_RETRY_MS);
      return this.requestRefresh(2);
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ApiError({ status: response.status, code: code || 'SERVICE_UNAVAILABLE', message: 'Session refresh failed' });
    }
    this.clear(false);
    return null;
  }
}
