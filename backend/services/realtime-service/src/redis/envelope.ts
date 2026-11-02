import { RealtimeEnvelope } from '../events/types';

/** Ids and event names go into SSE `id:` / `event:` lines: only characters that can't break the framing */
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A Redis stream id, "<ms>-<seq>" */
const STREAM_ID = /^(\d{1,16})-(\d{1,16})$/;

export function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && STREAM_ID.test(value);
}

/** Orders two Redis stream ids (negative: a before b) */
export function compareStreamIds(a: string, b: string): number {
  const [, aMs, aSeq] = STREAM_ID.exec(a) ?? [];
  const [, bMs, bSeq] = STREAM_ID.exec(b) ?? [];
  const ms = BigInt(aMs ?? 0) - BigInt(bMs ?? 0);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(aSeq ?? 0) - BigInt(bSeq ?? 0);
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}

/** Validates an envelope read back from Redis (pub/sub message or replay log entry); null when unusable */
export function toEnvelope(value: unknown): RealtimeEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !SAFE_TOKEN.test(v.id)) return null;
  if (typeof v.type !== 'string' || !SAFE_TOKEN.test(v.type)) return null;
  if (typeof v.at !== 'string') return null;
  if (!v.data || typeof v.data !== 'object' || Array.isArray(v.data)) return null;
  return { id: v.id, type: v.type, at: v.at, data: v.data as Record<string, unknown> };
}

export function parseEnvelope(json: string): RealtimeEnvelope | null {
  try {
    return toEnvelope(JSON.parse(json));
  } catch {
    return null;
  }
}
