import Redis from 'ioredis';
import { UserRole } from '@banksphere/common';
import { REPLAY_LOG_MAXLEN, REPLAY_LOG_TTL_SECONDS } from '../config';
import { RealtimeEnvelope, RealtimeEventBody, roleChannel, userChannel, userLogKey, userStreamsKey } from '../events/types';
import { toEnvelope } from './envelope';

/**
 * Appends to the user's replay log and publishes on the user's channel as ONE atomic step, so a live event
 * always carries the id it has in the log (the client's Last-Event-ID) and nothing is ever published without
 * being replayable. A MULTI/EXEC block can't do this: the id XADD assigns isn't known until EXEC returns.
 *
 * The last DEDUPE_WINDOW log entries are checked for the delivery's key first, so a Kafka message that is
 * redelivered (rebalance, retry after a partial failure) is not shown twice.
 *
 * KEYS[1] log key   ARGV: channel, maxlen, ttl seconds, event JSON without id, dedupe key, dedupe window
 * Returns { id, duplicate (0|1) }.
 */
export const DELIVER_SCRIPT = `
local recent = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', tonumber(ARGV[6]))
for _, entry in ipairs(recent) do
  local fields = entry[2]
  for i = 1, #fields, 2 do
    if fields[i] == 'k' and fields[i + 1] == ARGV[5] then
      return { entry[1], 1 }
    end
  end
end
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'e', ARGV[4], 'k', ARGV[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PUBLISH', ARGV[1], '{"id":"' .. id .. '",' .. string.sub(ARGV[4], 2))
return { id, 0 }
`;

/**
 * Admits a stream into the user's registry (a sorted set of connection ids scored by their last heartbeat)
 * unless the user already has `limit` live streams. Entries not refreshed since `staleBefore` belong to a
 * replica that died without cleaning up and are pruned first. Atomic, so concurrent connects never overshoot.
 *
 * KEYS[1] registry key   ARGV: now ms, stale-before ms, limit, connection id, ttl seconds   Returns 1 or 0.
 */
export const ADMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return 1
`;

/** How many recent log entries the delivery script checks for a redelivered Kafka message */
export const DEDUPE_WINDOW = 20;

type ExecResult = Array<[Error | null, unknown]> | null;

/** The slice of ioredis the store uses (lets tests run the store against an in-memory double) */
export interface RealtimeRedisClient {
  rtDeliver(key: string, channel: string, maxlen: number, ttl: number, body: string, dedupeKey: string, window: number): Promise<[string, number]>;
  rtAdmit(key: string, now: number, staleBefore: number, limit: number, connectionId: string, ttl: number): Promise<number>;
  xrevrange(key: string, end: string, start: string, countToken: 'COUNT', count: number): Promise<Array<[string, string[]]>>;
  publish(channel: string, message: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  pipeline(): { zadd(key: string, score: number, member: string): unknown; expire(key: string, seconds: number): unknown; exec(): Promise<ExecResult> };
  ping(): Promise<string>;
}

/** Registers the Lua scripts on an ioredis client (EVALSHA, falling back to EVAL after a Redis restart) */
export function withRealtimeScripts(redis: Redis): RealtimeRedisClient {
  redis.defineCommand('rtDeliver', { numberOfKeys: 1, lua: DELIVER_SCRIPT });
  redis.defineCommand('rtAdmit', { numberOfKeys: 1, lua: ADMIT_SCRIPT });
  return redis as unknown as RealtimeRedisClient;
}

export interface StreamRegistration {
  userId: string;
  connectionId: string;
}

export interface RegistryOptions {
  limit: number;
  staleAfterMs: number;
}

/**
 * Everything the service keeps in the cache Redis, under the realtime-svc ACL (`~rt:*`, `&rt:*`):
 *   rt:log:user:<id>       stream, the last ~100 events of a user, 24 h (replay for Last-Event-ID)
 *   rt:user:<id>           channel, live events of a user
 *   rt:role:<ROLE>         channel, live events for a staff role (not logged: staff queues refetch anyway)
 *   rt:streams:user:<id>   sorted set, the user's open streams across replicas (per-user limit)
 */
export class RealtimeStore {
  constructor(private readonly redis: RealtimeRedisClient) {}

  /** Logs and publishes one user event; `duplicate` when this delivery was already made */
  public async deliverToUser(userId: string, event: RealtimeEventBody, dedupeKey: string): Promise<{ id: string; duplicate: boolean }> {
    const json = JSON.stringify({ type: event.type, at: event.at, data: event.data });
    const [id, duplicate] = await this.redis.rtDeliver(
      userLogKey(userId),
      userChannel(userId),
      REPLAY_LOG_MAXLEN,
      REPLAY_LOG_TTL_SECONDS,
      json,
      dedupeKey,
      DEDUPE_WINDOW
    );
    return { id: String(id), duplicate: Number(duplicate) === 1 };
  }

  public async publishToRole(role: UserRole, envelope: RealtimeEnvelope): Promise<void> {
    await this.redis.publish(roleChannel(role), JSON.stringify(envelope));
  }

  /**
   * The user's events after `afterId` (exclusive), oldest first. When more than `limit` were missed, the
   * NEWEST `limit` are returned: they connect without a gap to the live events that follow.
   */
  public async readSince(userId: string, afterId: string, limit: number): Promise<RealtimeEnvelope[]> {
    const entries = await this.redis.xrevrange(userLogKey(userId), '+', `(${afterId}`, 'COUNT', limit);
    const events: RealtimeEnvelope[] = [];
    for (const [id, fields] of entries.reverse()) {
      const index = fields.findIndex((f, i) => i % 2 === 0 && f === 'e');
      let stored: unknown = null;
      try {
        stored = index >= 0 ? JSON.parse(fields[index + 1] ?? '') : null;
      } catch {
        // an unreadable entry is skipped, never sent
      }
      const envelope = stored && typeof stored === 'object' ? toEnvelope({ ...stored, id }) : null;
      if (envelope) events.push(envelope);
    }
    return events;
  }

  /** False when the user already has the maximum number of live streams */
  public async admit(registration: StreamRegistration, options: RegistryOptions, now = Date.now()): Promise<boolean> {
    const admitted = await this.redis.rtAdmit(
      userStreamsKey(registration.userId),
      now,
      now - options.staleAfterMs,
      options.limit,
      registration.connectionId,
      Math.ceil((options.staleAfterMs * 2) / 1000)
    );
    return Number(admitted) === 1;
  }

  /** Heartbeat for this replica's streams: one round trip for all of them */
  public async refresh(registrations: StreamRegistration[], staleAfterMs: number, now = Date.now()): Promise<void> {
    if (!registrations.length) return;
    const pipeline = this.redis.pipeline();
    const ttl = Math.ceil((staleAfterMs * 2) / 1000);
    for (const r of registrations) {
      // Plain ZADD (not XX): an entry pruned while this replica was stalled is put back
      pipeline.zadd(userStreamsKey(r.userId), now, r.connectionId);
      pipeline.expire(userStreamsKey(r.userId), ttl);
    }
    const failed = (await pipeline.exec())?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  public async release(registration: StreamRegistration): Promise<void> {
    await this.redis.zrem(userStreamsKey(registration.userId), registration.connectionId);
  }

  public async ping(): Promise<void> {
    await this.redis.ping();
  }
}
