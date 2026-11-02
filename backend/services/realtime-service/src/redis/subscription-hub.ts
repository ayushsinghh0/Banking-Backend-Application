import { logger } from '@banksphere/common';
import { RealtimeEnvelope } from '../events/types';
import { parseEnvelope } from './envelope';

/** The slice of an ioredis connection in subscriber mode the hub uses */
export interface PubSubClient {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'ready' | 'close', listener: () => void): unknown;
  quit(): Promise<unknown>;
  readonly status: string;
}

export type ChannelListener = (envelope: RealtimeEnvelope, channel: string) => void;

/**
 * Every replica holds ONE Redis subscriber connection and subscribes only to the channels its own streams
 * need, reference counted: the first local stream of a user subscribes `rt:user:<id>`, the last one to leave
 * unsubscribes it. So a replica's pub/sub traffic grows with its own connections, never with the user base.
 *
 * `add` resolves once Redis has confirmed the subscription (a second stream joining a pending subscription
 * waits for the same confirmation), which is what lets a stream buffer live events BEFORE it reads the replay
 * log without leaving a gap between the two.
 */
export class SubscriptionHub {
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  private readonly pending = new Map<string, Promise<void>>();
  /** Channels whose UNSUBSCRIBE failed (connection down): retried when the connection is back */
  private readonly strays = new Set<string>();
  private readonly reconnectListeners: Array<() => void> = [];
  private connectionLost = false;
  private closed = false;

  constructor(private readonly client: PubSubClient) {
    client.on('message', (channel, message) => this.dispatch(channel, message));
    client.on('close', () => {
      if (!this.closed) this.connectionLost = true;
    });
    client.on('ready', () => {
      if (!this.connectionLost || this.closed) return;
      this.connectionLost = false;
      // ioredis emits 'ready' BEFORE it re-sends the old subscriptions; act after them, so an UNSUBSCRIBE
      // sent from here can't be overtaken by an automatic re-SUBSCRIBE of the same channel
      setImmediate(() => {
        if (this.closed) return;
        this.retryStrays();
        // Messages published while the connection was down are gone; the streams must catch up from the logs
        for (const listener of this.reconnectListeners) listener();
      });
    });
  }

  /** Called after the subscriber connection came back from an outage */
  public onReconnect(listener: () => void): void {
    this.reconnectListeners.push(listener);
  }

  public get channelCount(): number {
    return this.listeners.size;
  }

  public listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  public get healthy(): boolean {
    return !this.closed && this.client.status === 'ready';
  }

  public async add(channel: string, listener: ChannelListener): Promise<void> {
    if (this.closed) throw new Error('Subscription hub is closed');
    const existing = this.listeners.get(channel);
    if (existing) {
      existing.add(listener);
      const inFlight = this.pending.get(channel);
      if (inFlight) await inFlight; // rejects for everyone if the subscription failed
      return;
    }

    const set = new Set<ChannelListener>([listener]);
    this.listeners.set(channel, set);
    this.strays.delete(channel);
    const subscribed = this.client.subscribe(channel).then(() => undefined);
    this.pending.set(channel, subscribed);
    try {
      await subscribed;
    } catch (err) {
      // Nobody can be served from a channel Redis refused: forget it, so the next stream tries afresh
      if (this.listeners.get(channel) === set) this.listeners.delete(channel);
      throw err;
    } finally {
      if (this.pending.get(channel) === subscribed) this.pending.delete(channel);
    }
  }

  public remove(channel: string, listener: ChannelListener): void {
    const set = this.listeners.get(channel);
    if (!set || !set.delete(listener) || set.size > 0) return;
    this.listeners.delete(channel);
    if (this.closed) return;
    this.client.unsubscribe(channel).catch((err: unknown) => {
      this.strays.add(channel);
      logger.warn({ err: (err as Error)?.message }, 'Redis UNSUBSCRIBE failed; retrying when the connection is back');
    });
  }

  /** Unsubscribes everything and closes the subscriber connection */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const channels = [...this.listeners.keys()];
    this.listeners.clear();
    try {
      if (channels.length && this.client.status === 'ready') await this.client.unsubscribe(...channels);
    } catch {
      // closing anyway
    }
    await this.client.quit().catch(() => undefined);
  }

  private retryStrays(): void {
    for (const channel of [...this.strays]) {
      if (this.listeners.has(channel)) {
        this.strays.delete(channel);
        continue;
      }
      this.client
        .unsubscribe(channel)
        .then(() => this.strays.delete(channel))
        .catch(() => undefined);
    }
  }

  private dispatch(channel: string, message: string): void {
    const set = this.listeners.get(channel);
    if (!set?.size) return;
    // Parsed once per replica, not once per stream
    const envelope = parseEnvelope(message);
    if (!envelope) {
      logger.warn({ channel: channel.startsWith('rt:role:') ? channel : 'rt:user:*' }, 'Unreadable real-time message dropped');
      return;
    }
    for (const listener of [...set]) {
      try {
        listener(envelope, channel);
      } catch (err) {
        logger.error({ err }, 'Real-time listener failed');
      }
    }
  }
}
