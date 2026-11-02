import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AuthenticatedUser,
  EventStream,
  EventStreamOptions,
  HttpError,
  ServiceUnavailableError,
  TokenStateStore,
  getAuthenticatedUser,
  isStaffRole,
  logger,
  openEventStream,
} from '@banksphere/common';
import { RealtimeConfig, REPLAY_LIMIT } from '../config';
import { RealtimeEnvelope, roleChannel, typeLabel, userChannel } from '../events/types';
import { compareStreamIds, isStreamId } from '../redis/envelope';
import { RealtimeStore } from '../redis/realtime-store';
import { ChannelListener, SubscriptionHub } from '../redis/subscription-hub';
import { realtimeMetrics } from '../metrics';

export type StreamSettings = Pick<
  RealtimeConfig,
  'maxConnections' | 'maxStreamsPerUser' | 'heartbeatSeconds' | 'staleStreamSeconds' | 'revalidateSeconds' | 'maxBufferedBytes'
>;

export interface StreamManagerDeps {
  store: RealtimeStore;
  hub: SubscriptionHub;
  tokenState: TokenStateStore;
  settings: StreamSettings;
  /** Defaults to openEventStream; tests substitute a recorder */
  openStream?: (req: Request, res: Response, options: EventStreamOptions) => EventStream;
}

type CloseReason = 'client' | 'reauth' | 'revoked' | 'slow_client' | 'shutdown' | 'resync';

/** Live events that arrive while a stream is catching up are held; a flood beyond this forces a reconnect */
const MAX_PENDING_EVENTS = 1_000;
/** setTimeout's limit (~24.8 days); longer delays would fire immediately */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One client stream.
 *
 * Gap-free and duplicate-free catch-up: the stream subscribes to its channels FIRST and buffers what
 * arrives; then it reads the replay log after the client's Last-Event-ID; it sends the replay, then the
 * buffer, skipping user events whose stream id is not newer than the last one sent. Stream ids only grow
 * (each id is assigned in the same atomic step that publishes it), so the client's Last-Event-ID never moves
 * backwards. Role events (staff queues) have no stream id and are passed through.
 */
class StreamSession {
  readonly connectionId = crypto.randomUUID();
  readonly channels: string[];
  stream: EventStream | null = null;
  private phase: 'catching-up' | 'live' | 'closed' = 'catching-up';
  private pending: Array<{ envelope: RealtimeEnvelope; channel: string }> = [];
  private overflowed = false;
  private lastStreamId: string | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private revalidating = false;

  constructor(
    readonly user: AuthenticatedUser,
    private readonly res: Response,
    private readonly manager: StreamManager
  ) {
    this.channels = [userChannel(user.id), ...(isStaffRole(user.role) ? [roleChannel(user.role)] : [])];
  }

  get closed(): boolean {
    return this.phase === 'closed';
  }

  readonly listener: ChannelListener = (envelope, channel) => {
    if (this.phase === 'closed') return;
    if (this.phase === 'catching-up') {
      if (this.pending.length >= MAX_PENDING_EVENTS) this.overflowed = true;
      else this.pending.push({ envelope, channel });
      return;
    }
    this.write(envelope, channel);
  };

  /** Sends `ready`, the replayed events, then what arrived meanwhile; from then on events go out live */
  goLive(replay: RealtimeEnvelope[], heartbeatSeconds: number): void {
    const stream = this.stream!;
    stream.send('ready', { connectionId: this.connectionId, heartbeatSeconds });
    for (const envelope of replay) {
      if (this.write(envelope, userChannel(this.user.id))) realtimeMetrics.replayed.inc();
    }
    const held = this.pending;
    this.pending = [];
    for (const { envelope, channel } of held) this.write(envelope, channel);
    if (this.overflowed) {
      this.end('resync');
      return;
    }
    this.phase = 'live';
  }

  /** True when the event was written */
  private write(envelope: RealtimeEnvelope, channel: string): boolean {
    const stream = this.stream;
    if (!stream || stream.closed || this.phase === 'closed') return false;
    // A client that stopped reading must not make this replica buffer without bound
    if (this.res.writableLength > this.manager.settings.maxBufferedBytes) {
      logger.warn({ connectionId: this.connectionId, buffered: this.res.writableLength }, 'Real-time client is not reading; closing its stream');
      this.end('slow_client', false);
      return false;
    }
    const isUserEvent = channel === this.channels[0];
    if (isUserEvent) {
      if (!isStreamId(envelope.id)) return false;
      if (this.lastStreamId !== null && compareStreamIds(envelope.id, this.lastStreamId) <= 0) return false; // already sent
      this.lastStreamId = envelope.id;
    }
    // Only user events carry an SSE id: it is what the client sends back as Last-Event-ID
    const sent = stream.send(envelope.type, envelope, isUserEvent ? envelope.id : undefined);
    if (sent) realtimeMetrics.delivered.inc({ type: typeLabel(envelope.type) });
    return sent;
  }

  startTimers(revalidate: () => Promise<boolean>, revalidateMs: number): void {
    // At access-token expiry the client must come back with a fresh token
    const expiresAtMs = (this.user.expiresAt ?? Math.floor(Date.now() / 1000)) * 1000;
    const reauth = setTimeout(() => this.end('reauth'), Math.min(Math.max(0, expiresAtMs - Date.now()), MAX_TIMER_MS));
    reauth.unref?.();
    // Logging out, a password change or a revoked session must not leave a stream running until expiry
    const check = setInterval(() => {
      if (this.revalidating || this.phase === 'closed') return;
      this.revalidating = true;
      revalidate()
        .then((revoked) => {
          if (revoked) this.end('revoked');
        })
        .catch((err) => logger.debug({ err: (err as Error)?.message }, 'Token revalidation skipped (token store unavailable)'))
        .finally(() => {
          this.revalidating = false;
        });
    }, revalidateMs);
    check.unref?.();
    this.timers.push(reauth, check);
  }

  /** Ends the stream with a final control event telling the client what to do */
  end(reason: CloseReason, notify = true): void {
    if (this.phase === 'closed') return;
    const stream = this.stream;
    if (stream && !stream.closed && notify) {
      if (reason === 'reauth' || reason === 'revoked') {
        stream.send('reauth', { reason: reason === 'reauth' ? 'token_expired' : 'token_revoked' });
      } else if (reason === 'shutdown' || reason === 'resync') {
        stream.send('reconnect', { reason });
      }
    }
    this.manager.release(this, reason);
    if (stream && !stream.closed) {
      if (reason === 'shutdown') {
        // Let the server finish closing: end the connection (not just the response) once it is flushed
        const socket = this.res.socket;
        this.res.once('finish', () => socket?.end());
      }
      stream.close();
    }
  }

  /** Stops timers and listening; idempotent */
  dispose(): void {
    this.phase = 'closed';
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.pending = [];
  }
}

/**
 * Admits, serves and ends real-time streams on this replica: the per-replica cap, the per-user limit across
 * replicas (registry in Redis), subscriptions through the shared hub, catch-up from the replay log,
 * re-authentication at token expiry, revocation checks, and draining at shutdown.
 */
export class StreamManager {
  readonly settings: StreamSettings;
  private readonly sessions = new Set<StreamSession>();
  /** Streams being set up (counted against the per-replica cap) */
  private starting = 0;
  private draining = false;
  private registryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly openStream: NonNullable<StreamManagerDeps['openStream']>;

  constructor(private readonly deps: StreamManagerDeps) {
    this.settings = deps.settings;
    this.openStream = deps.openStream ?? openEventStream;
    // After a subscriber outage live events were lost: every stream reconnects and catches up (Last-Event-ID)
    deps.hub.onReconnect(() => {
      const count = this.closeAll('resync');
      if (count) logger.warn({ streams: count }, 'Redis subscriber reconnected; streams asked to reconnect and catch up');
    });
  }

  get size(): number {
    return this.sessions.size;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Starts the registry heartbeat (keeps this replica's streams counted toward the per-user limit) */
  start(): void {
    if (this.registryTimer) return;
    this.registryTimer = setInterval(() => void this.refreshRegistry(), this.settings.heartbeatSeconds * 1000);
    this.registryTimer.unref?.();
  }

  readonly handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    this.open(req, res).catch(next);
  };

  private async open(req: Request, res: Response): Promise<void> {
    const user = getAuthenticatedUser(req);
    if (this.draining) {
      realtimeMetrics.rejected.inc({ reason: 'draining' });
      res.setHeader('Retry-After', '1');
      throw new HttpError(503, 'SERVER_BUSY', 'This server is restarting; reconnect shortly');
    }
    if (this.sessions.size + this.starting >= this.settings.maxConnections) {
      realtimeMetrics.rejected.inc({ reason: 'replica_full' });
      res.setHeader('Retry-After', '5');
      throw new HttpError(503, 'SERVER_BUSY', 'Too many open streams on this server; reconnect shortly');
    }

    this.starting++;
    let session: StreamSession | null = null;
    let registered = false;
    try {
      let clientGone = false;
      res.once('close', () => {
        clientGone = true;
      });
      session = new StreamSession(user, res, this);
      const registration = { userId: user.id, connectionId: session.connectionId };
      const staleAfterMs = this.settings.staleStreamSeconds * 1000;

      const admitted = await this.dependency(() =>
        this.deps.store.admit(registration, { limit: this.settings.maxStreamsPerUser, staleAfterMs })
      );
      if (!admitted) {
        realtimeMetrics.rejected.inc({ reason: 'too_many_streams' });
        res.setHeader('Retry-After', String(this.settings.heartbeatSeconds));
        throw new HttpError(
          429,
          'TOO_MANY_STREAMS',
          `At most ${this.settings.maxStreamsPerUser} real-time connections are allowed per user; close another tab or device`
        );
      }
      registered = true;

      // 1. subscribe (and buffer)  2. read what was missed  3. send replay, then the buffer
      const s = session;
      await this.dependency(() => Promise.all(s.channels.map((channel) => this.deps.hub.add(channel, s.listener))));
      const lastEventId = req.header('last-event-id')?.trim();
      const replay = isStreamId(lastEventId)
        ? await this.dependency(() => this.deps.store.readSince(user.id, lastEventId, REPLAY_LIMIT))
        : [];

      if (clientGone || res.destroyed) {
        this.unwind(s, true);
        return;
      }

      s.stream = this.openStream(req, res, { heartbeatMs: this.settings.heartbeatSeconds * 1000 });
      this.sessions.add(s);
      realtimeMetrics.connections.inc();
      s.stream.onClose(() => this.release(s, 'client'));
      s.goLive(replay, this.settings.heartbeatSeconds);
      if (!s.closed) {
        s.startTimers(() => this.isRevoked(user), this.settings.revalidateSeconds * 1000);
      }
    } catch (err) {
      if (session && !this.sessions.has(session)) this.unwind(session, registered);
      throw err;
    } finally {
      this.starting--;
    }
  }

  /** Redis trouble while admitting a stream is the client's cue to retry, never a 500 */
  private async dependency<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Real-time stream setup failed: Redis unavailable');
      throw new ServiceUnavailableError('Real-time updates are temporarily unavailable');
    }
  }

  private isRevoked(user: AuthenticatedUser): Promise<boolean> {
    return this.deps.tokenState.isAccessTokenRevoked({
      userId: user.id,
      jti: user.jti ?? '',
      tokenVersion: user.tokenVersion ?? 0,
      sessionId: user.sessionId,
    });
  }

  /** Undoes a stream that never went live */
  private unwind(session: StreamSession, registered: boolean): void {
    session.dispose();
    for (const channel of session.channels) this.deps.hub.remove(channel, session.listener);
    if (registered) this.unregister(session);
  }

  /** Called once per stream when it ends, whatever ended it */
  release(session: StreamSession, reason: CloseReason): void {
    if (session.closed) return;
    session.dispose();
    for (const channel of session.channels) this.deps.hub.remove(channel, session.listener);
    if (this.sessions.delete(session)) {
      realtimeMetrics.connections.dec();
      realtimeMetrics.closed.inc({ reason });
    }
    this.unregister(session);
  }

  private unregister(session: StreamSession): void {
    this.deps.store
      .release({ userId: session.user.id, connectionId: session.connectionId })
      .catch((err) => logger.warn({ err: (err as Error)?.message }, 'Could not remove a stream from the registry (it expires on its own)'));
  }

  private async refreshRegistry(): Promise<void> {
    const registrations = [...this.sessions].map((s) => ({ userId: s.user.id, connectionId: s.connectionId }));
    try {
      await this.deps.store.refresh(registrations, this.settings.staleStreamSeconds * 1000);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Stream registry heartbeat failed');
    }
  }

  /** Ends every stream with a `reconnect` event; returns how many there were */
  closeAll(reason: 'shutdown' | 'resync'): number {
    const sessions = [...this.sessions];
    for (const session of sessions) session.end(reason);
    return sessions.length;
  }

  /**
   * Shutdown, step one: refuse new streams, tell every open stream to reconnect (to another replica) and
   * close it, so the HTTP server can stop without waiting for long-lived responses.
   */
  drain(): number {
    this.draining = true;
    if (this.registryTimer) clearInterval(this.registryTimer);
    this.registryTimer = null;
    return this.closeAll('shutdown');
  }
}
