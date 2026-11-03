import { parseRate } from '@banksphere/common';

/**
 * Everything the assistant reads from the environment, parsed and validated once at startup. A malformed value
 * stops the service instead of silently disabling a guardrail (a NaN budget or a zero rate limit).
 */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Per completion request (each tool round is one request) */
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
}

export interface TransferPolicyConfig {
  customerDailyOutflowPaise: bigint;
  stepUpThresholdPaise: bigint;
  beneficiaryCoolingMinutes: number;
  newBeneficiaryLimitPaise: bigint;
  withdrawalCodeTtlMinutes: number;
  withdrawalCodeStepUpPaise: bigint;
  mfaFactorMinAgeHours: number;
  cashSingleApprovalPaise: bigint;
  tellerDailyLimitPaise: bigint;
  cashApprovalTtlHours: number;
}

export interface AssistantConfig {
  /** null: no LLM_API_KEY, the built-in assistant answers */
  llm: LlmConfig | null;
  dailyTokenBudget: number;
  retentionDays: number;
  rate: { limit: number; periodMs: number; burst: number };
  /** Earlier messages of the conversation sent to the model as context */
  historyMessages: number;
  /** Pause between words when the built-in assistant streams (0 in tests) */
  builtinWordDelayMs: number;
  upstream: {
    accountUrl: string;
    transactionUrl: string;
    customerUrl: string;
    paymentUrl: string;
    timeoutMs: number;
  };
  policy: TransferPolicyConfig;
}

export function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim();
  if (!/^\d{1,15}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number between ${min} and ${max}`);
  }
  return Number(value);
}

function envPaise(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,18}$/.test(raw.trim())) throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a whole number of paise`);
  return BigInt(raw.trim());
}

function envUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = (env[name] || fallback).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Invalid ${name}: expected an http(s) URL`);
  return value;
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const apiKey = env.LLM_API_KEY?.trim();
  let llm: LlmConfig | null = null;
  if (apiKey && !/CHANGE_ME/i.test(apiKey)) {
    const baseUrl = envUrl(env, 'LLM_BASE_URL', 'https://api.openai.com/v1');
    // Customers' balances and transactions go to this endpoint: never in clear text across a network in production
    const url = new URL(baseUrl);
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:' && !LOCAL_HOSTS.test(url.hostname) && env.LLM_ALLOW_HTTP !== 'true') {
      throw new Error('LLM_BASE_URL must use https in production (set LLM_ALLOW_HTTP=true only for a model server on a private network)');
    }
    const temperature = Number(env.LLM_TEMPERATURE ?? '0.2');
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('Invalid LLM_TEMPERATURE: expected 0..2');
    const model = (env.LLM_MODEL || 'gpt-4o-mini').trim();
    if (!/^[\w.:/@-]{1,100}$/.test(model)) throw new Error('Invalid LLM_MODEL');
    llm = {
      apiKey,
      baseUrl,
      model,
      timeoutMs: envInt(env, 'LLM_TIMEOUT_MS', 30_000, 1_000, 120_000),
      maxOutputTokens: envInt(env, 'LLM_MAX_OUTPUT_TOKENS', 600, 50, 4_000),
      temperature,
    };
  }

  const rate = parseRate(env.ASSISTANT_RATE_LIMIT || '20/min');
  return {
    llm,
    dailyTokenBudget: envInt(env, 'ASSISTANT_DAILY_TOKEN_BUDGET', 50_000, 1),
    retentionDays: envInt(env, 'ASSISTANT_RETENTION_DAYS', 30, 1, 3_650),
    rate: { ...rate, burst: envInt(env, 'ASSISTANT_RATE_BURST', 5, 1, 1_000) },
    historyMessages: envInt(env, 'ASSISTANT_HISTORY_MESSAGES', 12, 0, 50),
    builtinWordDelayMs: envInt(env, 'ASSISTANT_BUILTIN_WORD_DELAY_MS', env.NODE_ENV === 'test' ? 0 : 12, 0, 500),
    upstream: {
      accountUrl: envUrl(env, 'ACCOUNT_SERVICE_URL', 'http://localhost:8003'),
      transactionUrl: envUrl(env, 'TRANSACTION_SERVICE_URL', 'http://localhost:8004'),
      customerUrl: envUrl(env, 'CUSTOMER_SERVICE_URL', 'http://localhost:8002'),
      paymentUrl: envUrl(env, 'PAYMENT_SERVICE_URL', 'http://localhost:8007'),
      timeoutMs: envInt(env, 'UPSTREAM_TIMEOUT_MS', 5_000, 200, 30_000),
    },
    // The ledger's own settings (same variable names as transaction-service), used only to explain limits
    policy: loadPolicy(env),
  };
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): TransferPolicyConfig {
  return {
    customerDailyOutflowPaise: envPaise(env, 'CUSTOMER_DAILY_OUTFLOW_LIMIT_PAISE', 50_000_000n),
    stepUpThresholdPaise: envPaise(env, 'STEP_UP_THRESHOLD_PAISE', 10_000_000n),
    beneficiaryCoolingMinutes: envInt(env, 'BENEFICIARY_COOLING_MINUTES', 60, 0),
    newBeneficiaryLimitPaise: envPaise(env, 'NEW_BENEFICIARY_LIMIT_PAISE', 5_000_000n),
    withdrawalCodeTtlMinutes: envInt(env, 'WITHDRAWAL_CODE_TTL_MINUTES', 15, 1),
    withdrawalCodeStepUpPaise: envPaise(env, 'WITHDRAWAL_CODE_STEP_UP_PAISE', 2_500_000n),
    mfaFactorMinAgeHours: envInt(env, 'MFA_FACTOR_MIN_AGE_HOURS', 24, 0),
    cashSingleApprovalPaise: envPaise(env, 'CASH_SINGLE_APPROVAL_LIMIT_PAISE', 20_000_000n),
    tellerDailyLimitPaise: envPaise(env, 'TELLER_DAILY_LIMIT_PAISE', 100_000_000n),
    cashApprovalTtlHours: envInt(env, 'CASH_APPROVAL_TTL_HOURS', 24, 1),
  };
}
