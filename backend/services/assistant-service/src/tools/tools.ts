import { z } from 'zod';
import { isStaff } from '@banksphere/common';
import { TransferPolicyConfig } from '../config';
import { Card, ToolName, TopUpStatus } from '../assistant/types';
import { TurnAbortedError } from '../assistant/errors';
import { HelpArticle } from '../knowledge/articles';
import { searchHelp } from '../knowledge/search';
import { formatInr, istDate, parseAmountToPaise } from '../util/money';
import { cleanText, last4, safeDescription } from '../util/masking';
import { BankingApi, ToolContext, UpstreamAccount, UpstreamHistoryEntry } from './banking-api';

/**
 * The assistant's tools. All of them are read-only: they fetch through the owning services as the customer,
 * reduce the answer to what the question needs (last 4 digits, cleaned and bounded text, no internal ids beyond
 * the account id the app needs for a draft), and return two things: a card for the app and data for the answer.
 * draft_transfer only builds a card; nothing here can move money or change anything.
 */
export type ToolErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID';

export type ToolOutcome<D = unknown> =
  | { ok: true; data: D; card: Card | null }
  | { ok: false; code: ToolErrorCode; error: string; status?: number };

export interface ToolSpec<A = any, D = any> {
  name: ToolName;
  /** Status line the app shows while the tool runs */
  label: string;
  description: string;
  /** JSON schema of the arguments, for the model */
  parameters: Record<string, unknown>;
  args: z.ZodType<A>;
  /** Customer data tools; staff only get search_help */
  customerOnly: boolean;
  run(args: A, ctx: ToolContext): Promise<ToolOutcome<D>>;
}

// --- data shapes handed to the model (and to the built-in assistant's templates) ---------------------------------

export interface AccountsData {
  accounts: Array<{ id: string; label: string; last4: string; status: string; balance?: string; dailyLimit?: string }>;
  totalBalance?: string;
  /** Accounts whose balance couldn't be loaded (last 4 digits) */
  balanceUnavailable: string[];
}

export interface TransactionsData {
  account: string;
  transactions: Array<{ at: string; description: string; direction: 'in' | 'out'; amount: string }>;
}

export interface SpendingData {
  days: number;
  from: string;
  to: string;
  moneyIn: string;
  moneyOut: string;
  net: string;
  transactionsCounted: number;
  internalTransfersExcluded: number;
  biggestPayment?: { date: string; amount: string; description: string };
  /** Very busy accounts: only the most recent entries were added up */
  partial: boolean;
}

export interface PayeesData {
  payees: Array<{ nickname: string; last4: string; active: boolean; activatesAt?: string }>;
}

export interface TopUpsData {
  topUps: Array<{ amount: string; status: string; meaning: string; at: string; accountLast4?: string; failureReason?: string }>;
}

export interface LimitsData {
  lines: string[];
  kycStatus?: string;
}

export interface DraftData {
  draftOnly: true;
  from: string;
  to: string | null;
  amount: string | null;
  payeeNotFound?: string;
  warnings: string[];
  nextStep: string;
}

export interface HelpData {
  articles: Array<{ title: string; steps: string[] }>;
}

// --- helpers --------------------------------------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? undefined : cleanText(String(v), max) || undefined));
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === null || v === '' ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

function failure(error: unknown, ctx: ToolContext, topic: string): ToolOutcome<never> {
  if (ctx.signal.aborted) throw new TurnAbortedError();
  const status = Number((error as { statusCode?: unknown })?.statusCode) || undefined;
  if (status === 401) return { ok: false, code: 'UNAUTHORIZED', status, error: 'Your session has expired. Please sign in again.' };
  if (status === 403) return { ok: false, code: 'FORBIDDEN', status, error: `I can’t access ${topic} for your profile.` };
  if (status === 404) return { ok: false, code: 'NOT_FOUND', status, error: `I couldn’t find ${topic}.` };
  if (status === 429) return { ok: false, code: 'RATE_LIMITED', status, error: 'There were too many requests just now. Please try again in a minute.' };
  return { ok: false, code: 'UNAVAILABLE', status, error: `I couldn’t load ${topic} right now. Please try again in a minute.` };
}

const TYPE_NAMES: Record<string, string> = { SAVINGS: 'Savings', CURRENT: 'Current' };

function typeName(account: UpstreamAccount): string {
  return TYPE_NAMES[String(account.accountType)] ?? 'Account';
}

/** "Savings" or "Savings (frozen)": the card shows the last 4 digits next to it */
function cardLabel(account: UpstreamAccount): string {
  const status = String(account.status ?? 'ACTIVE');
  return status === 'ACTIVE' ? typeName(account) : `${typeName(account)} (${status.toLowerCase()})`;
}

/** "Savings ••1234" */
export function accountName(account: UpstreamAccount): string {
  return `${typeName(account)} ••${last4(account.accountNumber)}`;
}

const isOpen = (a: UpstreamAccount) => a.status !== 'CLOSED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account the customer means: by id, by its last 4 digits, or their main (first active) account */
function pickAccount(accounts: UpstreamAccount[], ref: string | undefined): UpstreamAccount | 'ambiguous' | null {
  const open = accounts.filter(isOpen);
  if (!ref) return open.find((a) => a.status === 'ACTIVE') ?? open[0] ?? null;
  if (UUID.test(ref)) return open.find((a) => a.id.toLowerCase() === ref.toLowerCase()) ?? null;
  const digits = ref.replace(/\D/g, '');
  if (digits.length !== 4) return null;
  const matches = open.filter((a) => last4(a.accountNumber) === digits);
  return matches.length > 1 ? 'ambiguous' : (matches[0] ?? null);
}

const ACCOUNT_NOT_FOUND: ToolOutcome<never> = {
  ok: false,
  code: 'NOT_FOUND',
  error: 'I couldn’t find that account among yours. You can name it by its last 4 digits.',
};
const ACCOUNT_AMBIGUOUS: ToolOutcome<never> = {
  ok: false,
  code: 'INVALID',
  error: 'More than one of your accounts ends with those digits. Please choose the account in the app.',
};
const NO_ACCOUNTS: ToolOutcome<never> = { ok: false, code: 'NOT_FOUND', error: 'You don’t have any open accounts yet.' };

const ENTRY_TYPE_NAMES: Record<string, string> = {
  TRANSFER: 'Transfer',
  DEPOSIT: 'Cash deposit',
  WITHDRAWAL: 'Cash withdrawal',
  ONLINE_TOP_UP: 'Money added online',
  TOP_UP_REFUND: 'Top-up refund',
};

function entryDescription(entry: UpstreamHistoryEntry): string {
  return safeDescription(entry.description) || ENTRY_TYPE_NAMES[String(entry.type)] || 'Transaction';
}

function isoString(value: unknown): string | null {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const PAISE = /^\d{1,18}$/;
const paiseOrNull = (value: unknown): bigint | null => (typeof value === 'string' && PAISE.test(value) ? BigInt(value) : null);

const TOP_UP_MEANINGS: Record<TopUpStatus, string> = {
  CREATED: 'started, waiting for payment',
  PENDING: 'payment in progress',
  CAPTURED: 'paid, being added to your account',
  CREDITED: 'added to your account',
  CREDIT_BLOCKED: 'paid, but it couldn’t be added (account frozen or closed), so it will be refunded',
  REFUND_PENDING: 'refund in progress',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled before payment',
  FAILED: 'payment failed',
  EXPIRED: 'expired without a payment',
};

// --- the tools ----------------------------------------------------------------------------------------------------

export interface ToolDeps {
  api: BankingApi;
  articles: readonly HelpArticle[];
  policy: TransferPolicyConfig;
  now?: () => Date;
}

export function createTools(deps: ToolDeps): ToolSpec[] {
  const { api, policy } = deps;
  const now = deps.now ?? (() => new Date());
  const inr = (paise: bigint) => formatInr(paise).replace(/\.00$/, '');

  const listAccounts: ToolSpec<Record<string, never>, AccountsData> = {
    name: 'list_accounts',
    label: 'Checking your accounts',
    description: 'The customer’s open accounts with their current balances and daily transfer limits.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    args: z.object({}).transform(() => ({}) as Record<string, never>),
    customerOnly: true,
    async run(_args, ctx) {
      let accounts: UpstreamAccount[];
      try {
        accounts = (await api.listAccounts(ctx)).filter(isOpen).slice(0, 10);
      } catch (error) {
        return failure(error, ctx, 'your accounts');
      }
      if (!accounts.length) return { ok: true, data: { accounts: [], balanceUnavailable: [] }, card: null };

      const balances = await Promise.allSettled(accounts.map((a) => api.getBalance(ctx, a.id)));
      if (ctx.signal.aborted) throw new TurnAbortedError();
      const rejected = balances.find((b): b is PromiseRejectedResult => b.status === 'rejected');
      if (rejected && balances.every((b) => b.status === 'rejected')) return failure(rejected.reason, ctx, 'your balances');

      const data: AccountsData = { accounts: [], balanceUnavailable: [] };
      const card: Extract<Card, { type: 'accounts' }> = { type: 'accounts', accounts: [] };
      let total = 0n;
      accounts.forEach((account, i) => {
        const result = balances[i];
        const balance = result.status === 'fulfilled' ? paiseOrNull(result.value?.balanceInPaise) : null;
        const digits = last4(account.accountNumber);
        const limit = paiseOrNull(account.dailyLimitPaise);
        data.accounts.push({
          id: account.id,
          label: cardLabel(account),
          last4: digits,
          status: String(account.status ?? 'ACTIVE'),
          ...(balance !== null && { balance: formatInr(balance) }),
          ...(limit !== null && { dailyLimit: formatInr(limit) }),
        });
        if (balance === null) {
          data.balanceUnavailable.push(digits);
          return;
        }
        total += balance;
        card.accounts.push({ id: account.id, label: cardLabel(account), last4: digits, balancePaise: balance.toString() });
      });
      data.totalBalance = formatInr(total);
      return { ok: true, data, card };
    },
  };

  const recentTransactions: ToolSpec<{ account?: string; limit?: number }, TransactionsData> = {
    name: 'recent_transactions',
    label: 'Looking at recent transactions',
    description: 'The most recent transactions on one of the customer’s accounts (newest first).',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id, or its last 4 digits. Omit for the main account.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many transactions (default 10).' },
      },
      additionalProperties: false,
    },
    args: z.object({ account: optionalText(64), limit: optionalInt(1, 20) }),
    customerOnly: true,
    async run(args, ctx) {
      let accounts: UpstreamAccount[];
      try {
        accounts = await api.listAccounts(ctx);
      } catch (error) {
        return failure(error, ctx, 'your accounts');
      }
      const account = pickAccount(accounts, args.account);
      if (account === 'ambiguous') return ACCOUNT_AMBIGUOUS;
      if (!account) return accounts.some(isOpen) ? ACCOUNT_NOT_FOUND : NO_ACCOUNTS;

      let entries: UpstreamHistoryEntry[];
      try {
        entries = await api.getHistory(ctx, account.id, args.limit ?? 10, 0);
      } catch (error) {
        return failure(error, ctx, 'the transactions on that account');
      }
      const items = entries.flatMap((entry) => {
        const amount = paiseOrNull(entry.amountInPaise);
        const at = isoString(entry.createdAt);
        if (amount === null || !at || (entry.entryType !== 'CREDIT' && entry.entryType !== 'DEBIT')) return [];
        return [{ id: String(entry.entryId), at, description: entryDescription(entry), direction: entry.entryType, amountPaise: amount.toString() }];
      });
      const name = accountName(account);
      return {
        ok: true,
        data: {
          account: name,
          transactions: items.map((i) => ({
            at: i.at,
            description: i.description,
            direction: i.direction === 'CREDIT' ? ('in' as const) : ('out' as const),
            amount: formatInr(i.amountPaise),
          })),
        },
        card: { type: 'transactions', accountLabel: name, items },
      };
    },
  };

  const spendingSummary: ToolSpec<{ days?: number; account?: string }, SpendingData> = {
    name: 'spending_summary',
    label: 'Adding up your spending',
    description:
      'Money in and money out over the last N days (India time), across all the customer’s accounts or one account. Transfers between the customer’s own accounts are left out.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: 'Number of days up to today (default 30).' },
        account: { type: 'string', description: 'Account id or its last 4 digits. Omit for all accounts.' },
      },
      additionalProperties: false,
    },
    args: z.object({ days: optionalInt(1, 90), account: optionalText(64) }),
    customerOnly: true,
    async run(args, ctx) {
      const days = args.days ?? 30;
      let accounts: UpstreamAccount[];
      try {
        accounts = (await api.listAccounts(ctx)).filter(isOpen);
      } catch (error) {
        return failure(error, ctx, 'your accounts');
      }
      let selected = accounts.slice(0, 5);
      if (args.account) {
        const account = pickAccount(accounts, args.account);
        if (account === 'ambiguous') return ACCOUNT_AMBIGUOUS;
        if (!account) return ACCOUNT_NOT_FOUND;
        selected = [account];
      }
      if (!selected.length) return NO_ACCOUNTS;

      // India has no daylight saving: every IST day is exactly 24 hours
      const today = istDate(now());
      const todayMidnight = Date.parse(`${today}T00:00:00+05:30`);
      const dates: string[] = [];
      for (let i = days - 1; i >= 0; i--) dates.push(istDate(new Date(todayMidnight - i * 86_400_000)));
      const since = new Date(todayMidnight - (days - 1) * 86_400_000);

      const results = await Promise.allSettled(selected.map((a) => historySince(api, ctx, a.id, since)));
      if (ctx.signal.aborted) throw new TurnAbortedError();
      const loaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (!loaded.length && firstError) return failure(firstError.reason, ctx, 'your transactions');

      // A transfer between two of the customer's own accounts appears in both: it is neither income nor spending
      const seen = new Map<string, number>();
      for (const { entries } of loaded) for (const id of new Set(entries.map((e) => e.transactionId))) seen.set(id, (seen.get(id) ?? 0) + 1);
      const internal = new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));

      const byDay = new Map(dates.map((d) => [d, { inPaise: 0n, outPaise: 0n }]));
      let moneyIn = 0n;
      let moneyOut = 0n;
      let counted = 0;
      let biggest: { entry: UpstreamHistoryEntry; amount: bigint } | null = null;
      for (const { entries } of loaded) {
        for (const entry of entries) {
          const amount = paiseOrNull(entry.amountInPaise);
          const at = isoString(entry.createdAt);
          if (amount === null || !at || internal.has(entry.transactionId)) continue;
          const day = byDay.get(istDate(new Date(at)));
          if (!day) continue;
          counted++;
          if (entry.entryType === 'CREDIT') {
            moneyIn += amount;
            day.inPaise += amount;
          } else if (entry.entryType === 'DEBIT') {
            moneyOut += amount;
            day.outPaise += amount;
            if (!biggest || amount > biggest.amount) biggest = { entry, amount };
          }
        }
      }

      const data: SpendingData = {
        days,
        from: dates[0],
        to: today,
        moneyIn: formatInr(moneyIn),
        moneyOut: formatInr(moneyOut),
        net: formatInr(moneyIn - moneyOut),
        transactionsCounted: counted,
        internalTransfersExcluded: internal.size,
        partial: loaded.some((l) => l.truncated) || loaded.length < selected.length,
      };
      if (biggest) {
        data.biggestPayment = {
          date: istDate(new Date(biggest.entry.createdAt)),
          amount: formatInr(biggest.amount),
          description: entryDescription(biggest.entry),
        };
      }
      return {
        ok: true,
        data,
        card: {
          type: 'spending',
          days,
          inPaise: moneyIn.toString(),
          outPaise: moneyOut.toString(),
          byDay: dates.map((date) => ({ date, inPaise: byDay.get(date)!.inPaise.toString(), outPaise: byDay.get(date)!.outPaise.toString() })),
        },
      };
    },
  };

  const listPayees: ToolSpec<Record<string, never>, PayeesData> = {
    name: 'list_payees',
    label: 'Checking your payees',
    description: 'The customer’s saved payees (beneficiaries), and whether each can be paid yet (new payees have a cooling-off period).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    args: z.object({}).transform(() => ({}) as Record<string, never>),
    customerOnly: true,
    async run(_args, ctx) {
      try {
        const payees = (await api.listBeneficiaries(ctx)).slice(0, 50);
        const at = now().getTime();
        const items = payees.map((p) => {
          const activatesAt = isoString(p.activatesAt);
          const active = !activatesAt || Date.parse(activatesAt) <= at;
          return { nickname: cleanText(p.nickname, 60) || 'Payee', last4: last4(p.accountNumber), active, ...(!active && activatesAt ? { activatesAt } : {}) };
        });
        return {
          ok: true,
          data: { payees: items },
          card: items.length ? { type: 'payees', items: items.map(({ nickname, last4: l4, active }) => ({ nickname, last4: l4, active })) } : null,
        };
      } catch (error) {
        return failure(error, ctx, 'your payees');
      }
    },
  };

  const listTopUps: ToolSpec<{ limit?: number }, TopUpsData> = {
    name: 'list_top_ups',
    label: 'Checking your top-ups',
    description: 'The customer’s most recent “add money” top-ups (Razorpay) with their status, newest first.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many (default 5).' } },
      additionalProperties: false,
    },
    args: z.object({ limit: optionalInt(1, 10) }),
    customerOnly: true,
    async run(args, ctx) {
      try {
        const topUps = (await api.listTopUps(ctx, args.limit ?? 5)).slice(0, args.limit ?? 5);
        const rows = topUps.flatMap((t) => {
          const amount = paiseOrNull(t.amountPaise);
          const at = isoString(t.createdAt);
          if (amount === null || !at) return [];
          const status = String(t.status) as TopUpStatus;
          return [{ id: String(t.id), amount, status, at, known: Object.hasOwn(TOP_UP_MEANINGS, status), topUp: t }];
        });
        return {
          ok: true,
          data: {
            topUps: rows.map((r) => ({
              amount: formatInr(r.amount),
              status: r.status,
              meaning: r.known ? TOP_UP_MEANINGS[r.status] : 'status unknown',
              at: r.at,
              ...(r.topUp.accountNumberLast4 ? { accountLast4: last4(r.topUp.accountNumberLast4) } : {}),
              ...(r.topUp.failureReason ? { failureReason: cleanText(r.topUp.failureReason, 120) } : {}),
            })),
          },
          card: rows.length
            ? { type: 'topups', items: rows.filter((r) => r.known).map((r) => ({ id: r.id, amountPaise: r.amount.toString(), status: r.status, at: r.at })) }
            : null,
        };
      } catch (error) {
        return failure(error, ctx, 'your top-ups');
      }
    },
  };

  const explainLimits: ToolSpec<Record<string, never>, LimitsData> = {
    name: 'explain_limits',
    label: 'Checking your limits',
    description: 'The customer’s transfer, payee, withdrawal-code and add-money limits, including what is left of today’s top-up limit.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    args: z.object({}).transform(() => ({}) as Record<string, never>),
    customerOnly: true,
    async run(_args, ctx) {
      // Each part is optional: the bank-wide rules can always be explained, even if a service is down
      const [accounts, config, profile] = await Promise.allSettled([api.listAccounts(ctx), api.getPaymentConfig(ctx), api.getProfile(ctx)]);
      if (ctx.signal.aborted) throw new TurnAbortedError();
      const lines: string[] = [];
      if (accounts.status === 'fulfilled') {
        for (const account of accounts.value.filter(isOpen).slice(0, 10)) {
          const limit = paiseOrNull(account.dailyLimitPaise);
          if (limit !== null) lines.push(`${accountName(account)}: up to ${inr(limit)} a day`);
        }
      }
      lines.push(`All your accounts together: up to ${inr(policy.customerDailyOutflowPaise)} a day (resets at midnight India time)`);
      lines.push(`Transfers of ${inr(policy.stepUpThresholdPaise)} or more need your authenticator code`);
      lines.push(
        policy.beneficiaryCoolingMinutes > 0
          ? `New payees: usable after ${policy.beneficiaryCoolingMinutes} minutes (or at once with your authenticator), up to ${inr(policy.newBeneficiaryLimitPaise)} in their first 24 hours`
          : `New payees: up to ${inr(policy.newBeneficiaryLimitPaise)} in their first 24 hours`
      );
      lines.push(
        `Withdrawal codes: valid ${policy.withdrawalCodeTtlMinutes} minutes; ${inr(policy.withdrawalCodeStepUpPaise)} or more needs your authenticator code`
      );
      const limits = config.status === 'fulfilled' ? config.value?.limits : undefined;
      const min = paiseOrNull(limits?.minPaise);
      const max = paiseOrNull(limits?.maxPaise);
      const remaining = paiseOrNull(limits?.remainingTodayPaise);
      const daily = paiseOrNull(limits?.dailyLimitPaise);
      if (min !== null && max !== null) {
        const today = remaining !== null ? `; ${inr(remaining)} left today` : daily !== null ? `; up to ${inr(daily)} a day` : '';
        lines.push(`Add money: ${inr(min)} to ${inr(max)} per top-up${today}`);
      }
      const kycStatus = profile.status === 'fulfilled' && typeof profile.value?.kycStatus === 'string' ? profile.value.kycStatus : undefined;
      if (kycStatus && kycStatus !== 'VERIFIED') lines.push(`Your KYC is ${kycStatus.toLowerCase()}: adding money needs verified KYC`);
      return { ok: true, data: { lines, ...(kycStatus && { kycStatus }) }, card: { type: 'help', title: 'Your limits', steps: lines } };
    },
  };

  const draftTransfer: ToolSpec<{ fromAccount?: string; toPayee?: string; amount?: string; note?: string }, DraftData> = {
    name: 'draft_transfer',
    label: 'Preparing a transfer draft',
    description:
      'Prepares a transfer DRAFT for the customer to review and confirm on the transfer screen. It never sends money. Use it when the customer wants to send or pay someone.',
    parameters: {
      type: 'object',
      properties: {
        fromAccount: { type: 'string', description: 'Account id or last 4 digits to pay from. Omit for the main account.' },
        toPayee: { type: 'string', description: 'The payee’s nickname as the customer said it.' },
        amount: { type: 'string', description: 'Amount in rupees, e.g. "500" or "1,500.50".' },
        note: { type: 'string', description: 'Optional short note, e.g. "rent".' },
      },
      additionalProperties: false,
    },
    args: z.object({ fromAccount: optionalText(64), toPayee: optionalText(60), amount: optionalText(32), note: optionalText(100) }),
    customerOnly: true,
    async run(args, ctx) {
      let accounts: UpstreamAccount[];
      try {
        accounts = await api.listAccounts(ctx);
      } catch (error) {
        return failure(error, ctx, 'your accounts');
      }
      const from = pickAccount(accounts, args.fromAccount);
      if (from === 'ambiguous') return ACCOUNT_AMBIGUOUS;
      if (!from) return accounts.some(isOpen) ? ACCOUNT_NOT_FOUND : NO_ACCOUNTS;

      const warnings: string[] = [];
      if (from.status !== 'ACTIVE') warnings.push(`${accountName(from)} is ${String(from.status).toLowerCase()}, so it can’t send money.`);
      const amountPaise = args.amount ? parseAmountToPaise(args.amount) : null;
      if (args.amount && amountPaise === null) warnings.push('I couldn’t read the amount; enter it on the transfer screen.');

      const [payeesResult, balanceResult] = await Promise.allSettled([
        args.toPayee ? api.listBeneficiaries(ctx) : Promise.resolve([]),
        amountPaise !== null ? api.getBalance(ctx, from.id) : Promise.resolve(null),
      ]);
      if (ctx.signal.aborted) throw new TurnAbortedError();

      let toPayeeNickname: string | undefined;
      let payeeNotFound: string | undefined;
      if (args.toPayee) {
        if (payeesResult.status === 'rejected') {
          warnings.push('I couldn’t check your payees just now; choose the payee on the transfer screen.');
        } else {
          const wanted = args.toPayee.toLowerCase().replace(/^(my|mere|meri|mera)\s+/, '').trim();
          const payees = payeesResult.value;
          const nick = (p: (typeof payees)[number]) => cleanText(p.nickname, 60).toLowerCase();
          const exact = payees.filter((p) => nick(p) === wanted);
          const partial = payees.filter((p) => nick(p).includes(wanted) || (wanted.includes(nick(p)) && nick(p).length >= 3));
          const payee = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
          if (!payee) {
            payeeNotFound = args.toPayee;
            warnings.push(
              partial.length > 1
                ? `More than one payee matches “${args.toPayee}”; choose the right one on the transfer screen.`
                : `You don’t have a payee called “${args.toPayee}”. Add them under Payees first, or choose another payee.`
            );
          } else {
            toPayeeNickname = cleanText(payee.nickname, 60);
            const activatesAt = isoString(payee.activatesAt);
            const createdAt = isoString(payee.createdAt) ?? activatesAt;
            if (activatesAt && Date.parse(activatesAt) > now().getTime()) {
              warnings.push(`${toPayeeNickname} can be paid from ${new Date(activatesAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })} (new payee cooling-off).`);
            }
            if (amountPaise !== null && createdAt && now().getTime() - Date.parse(createdAt) < 86_400_000 && amountPaise > policy.newBeneficiaryLimitPaise) {
              warnings.push(`New payees can receive up to ${inr(policy.newBeneficiaryLimitPaise)} in their first 24 hours.`);
            }
          }
        }
      }
      if (amountPaise !== null) {
        const balance = balanceResult.status === 'fulfilled' ? paiseOrNull(balanceResult.value?.balanceInPaise) : null;
        if (balance !== null && amountPaise > balance) warnings.push(`That’s more than the ${formatInr(balance)} available in ${accountName(from)}.`);
        if (amountPaise >= policy.stepUpThresholdPaise) warnings.push('You’ll be asked for your authenticator code to confirm it.');
        const dailyLimit = paiseOrNull(from.dailyLimitPaise);
        if (dailyLimit !== null && amountPaise > dailyLimit) warnings.push(`That’s above this account’s daily limit of ${inr(dailyLimit)}.`);
      }

      const note = args.note ? safeDescription(args.note, 100) : undefined;
      const card: Extract<Card, { type: 'transferDraft' }> = { type: 'transferDraft', fromAccountId: from.id };
      if (toPayeeNickname) card.toPayeeNickname = toPayeeNickname;
      if (amountPaise !== null) card.amountPaise = amountPaise.toString();
      if (note) card.note = note;
      return {
        ok: true,
        data: {
          draftOnly: true,
          from: accountName(from),
          to: toPayeeNickname ?? null,
          amount: amountPaise !== null ? formatInr(amountPaise) : null,
          ...(payeeNotFound && { payeeNotFound }),
          warnings,
          nextStep: 'The customer reviews this draft and confirms it on the transfer screen. Sphere cannot send money.',
        },
        card,
      };
    },
  };

  const searchHelpTool: ToolSpec<{ query: string }, HelpData> = {
    name: 'search_help',
    label: 'Searching help articles',
    description: 'Searches BankSphere’s help articles (how-to steps, policies, and for staff, internal procedures).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the user wants to know, in a few words.' } },
      required: ['query'],
      additionalProperties: false,
    },
    args: z.object({ query: z.string().trim().min(1).max(300) }),
    customerOnly: false,
    async run(args, ctx) {
      const matches = searchHelp(deps.articles, args.query, isStaff(ctx.user) ? 'staff' : 'customer', 2);
      const top = matches[0]?.article;
      return {
        ok: true,
        data: { articles: matches.map((m) => ({ title: m.article.title, steps: m.article.steps })) },
        card: top ? { type: 'help', title: top.title, steps: top.steps } : null,
      };
    },
  };

  return [listAccounts, recentTransactions, spendingSummary, listPayees, listTopUps, explainLimits, draftTransfer, searchHelpTool];
}

/** Customers get every tool; every staff role gets search_help only */
export function toolsFor(user: ToolContext['user'], tools: readonly ToolSpec[]): ToolSpec[] {
  return isStaff(user) ? tools.filter((t) => !t.customerOnly) : [...tools];
}

async function historySince(
  api: BankingApi,
  ctx: ToolContext,
  accountId: string,
  since: Date,
  pageSize = 100,
  maxPages = 5
): Promise<{ entries: UpstreamHistoryEntry[]; truncated: boolean }> {
  const entries: UpstreamHistoryEntry[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await api.getHistory(ctx, accountId, pageSize, page * pageSize);
    for (const entry of batch) if (Date.parse(entry.createdAt) >= since.getTime()) entries.push(entry);
    const oldest = batch[batch.length - 1];
    if (batch.length < pageSize || !oldest || Date.parse(oldest.createdAt) < since.getTime()) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}
