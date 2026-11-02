import { GcraRule, parseRate } from '@banksphere/common';

/**
 * Edge limits (design section 10). Every value can be overridden from the environment and is validated at
 * startup: a typo must stop the gateway, never silently disable or tighten a limit.
 *
 *   tier          rate var                     burst var                     default
 *   ip            GATEWAY_RATE_IP              GATEWAY_BURST_IP              600/min, 200
 *   user          GATEWAY_RATE_USER            GATEWAY_BURST_USER            300/min, 100
 *   money-write   GATEWAY_RATE_MONEY_WRITE     GATEWAY_BURST_MONEY_WRITE      30/min,  10
 *   assistant     GATEWAY_RATE_ASSISTANT       GATEWAY_BURST_ASSISTANT        20/min,   5
 *   webhook       GATEWAY_RATE_WEBHOOK         GATEWAY_BURST_WEBHOOK         600/min, 100
 *
 * GATEWAY_RATE_LIMIT_PER_MINUTE (the old fixed-window setting) is still read as the per-IP rate when
 * GATEWAY_RATE_IP is not set, so existing deployments keep their configured ceiling.
 */
export interface EdgeLimits {
  ip: GcraRule;
  user: GcraRule;
  moneyWrite: GcraRule;
  assistant: GcraRule;
  webhook: GcraRule;
}

const MAX_BURST = 1_000_000;

function rule(env: NodeJS.ProcessEnv, name: string, key: string, rate: string, burst: number): GcraRule {
  const rateVar = `GATEWAY_RATE_${key}`;
  const burstVar = `GATEWAY_BURST_${key}`;
  let parsed: { limit: number; periodMs: number };
  try {
    parsed = parseRate(env[rateVar]?.trim() || rate);
  } catch (err) {
    throw new Error(`${rateVar}: ${(err as Error).message}`);
  }
  const burstValue = env[burstVar]?.trim() ? Number(env[burstVar]) : burst;
  if (!Number.isInteger(burstValue) || burstValue < 1 || burstValue > MAX_BURST) {
    throw new Error(`${burstVar} must be a whole number between 1 and ${MAX_BURST}`);
  }
  return { name, limit: parsed.limit, periodMs: parsed.periodMs, burst: burstValue };
}

export function edgeLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): EdgeLimits {
  const legacy = env.GATEWAY_RATE_LIMIT_PER_MINUTE?.trim();
  const ipDefault = legacy && !env.GATEWAY_RATE_IP ? `${legacy}/min` : '600/min';
  return {
    ip: rule(env, 'ip', 'IP', ipDefault, 200),
    user: rule(env, 'user', 'USER', '300/min', 100),
    moneyWrite: rule(env, 'money-write', 'MONEY_WRITE', '30/min', 10),
    assistant: rule(env, 'assistant', 'ASSISTANT', '20/min', 5),
    webhook: rule(env, 'webhook', 'WEBHOOK', '600/min', 100),
  };
}

/** A positive whole number from the environment, or the default; anything else stops the gateway */
export function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  return value;
}

export interface GatewayRuntimeConfig {
  /** Concurrent non-streaming requests per replica before shedding (GATEWAY_MAX_INFLIGHT) */
  maxInflight: number;
  /** Concurrent streams (SSE) per replica (GATEWAY_MAX_STREAMS) */
  maxStreams: number;
  /** Idle timeout for ordinary upstream requests (GATEWAY_UPSTREAM_TIMEOUT_MS) */
  upstreamTimeoutMs: number;
  /** Time allowed to open the upstream connection of a stream, which otherwise has no idle timeout */
  connectTimeoutMs: number;
  /** How often the IP deny rules version is checked (GATEWAY_IP_RULES_REFRESH_MS) */
  ipRulesRefreshMs: number;
}

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayRuntimeConfig {
  return {
    maxInflight: positiveIntFromEnv(env, 'GATEWAY_MAX_INFLIGHT', 1024),
    maxStreams: positiveIntFromEnv(env, 'GATEWAY_MAX_STREAMS', 5000),
    upstreamTimeoutMs: positiveIntFromEnv(env, 'GATEWAY_UPSTREAM_TIMEOUT_MS', 15_000),
    connectTimeoutMs: positiveIntFromEnv(env, 'GATEWAY_CONNECT_TIMEOUT_MS', 5_000),
    ipRulesRefreshMs: positiveIntFromEnv(env, 'GATEWAY_IP_RULES_REFRESH_MS', 5_000),
  };
}
