import { differenceInMinutes, formatDistanceStrict } from 'date-fns';
import { humanize } from '@/components/ui/primitives';
import { formatPaise } from '@/lib/money';

/** First 8 characters of a UUID: enough to tell people apart in a list, the full id is in the title/copy */
export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');

/** "+919876543210" -> "+91 ••••• 3210" (staff tables show only what they need to match a caller) */
export function maskPhone(phone: string): string {
  const compact = phone.replace(/[\s-]/g, '');
  if (compact.length <= 4) return compact;
  const prefix = compact.startsWith('+') ? `${compact.slice(0, 3)} ` : '';
  return `${prefix}••••• ${compact.slice(-4)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
/** Dates of birth are calendar dates stored at UTC midnight: format them in UTC so they never shift a day */
const calendarFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });

const toDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDateTime = (iso: string | null | undefined) => {
  const date = toDate(iso);
  return date ? dateTimeFormatter.format(date) : '—';
};

export const formatDate = (iso: string | null | undefined) => {
  const date = toDate(iso);
  return date ? dateFormatter.format(date) : '—';
};

export const formatCalendarDate = (iso: string | null | undefined) => {
  const date = toDate(iso);
  return date ? calendarFormatter.format(date) : '—';
};

export type WaitTone = 'neutral' | 'warning' | 'danger';

/** How long a profile has been waiting for review, with a tone that escalates after one and three days */
export function waitingTime(iso: string, now: number = Date.now()): { label: string; tone: WaitTone } {
  const since = toDate(iso);
  if (!since) return { label: '—', tone: 'neutral' };
  const minutes = Math.max(0, differenceInMinutes(now, since));
  const label = minutes < 1 ? 'Just now' : formatDistanceStrict(since, now, { roundingMethod: 'floor' });
  const tone: WaitTone = minutes >= 72 * 60 ? 'danger' : minutes >= 24 * 60 ? 'warning' : 'neutral';
  return { label, tone };
}

/** "reviewedVersion" / "reviewed_version" -> "Reviewed version" */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MAX_TEXT = 500;

/**
 * Renders an arbitrary JSON value from an audit record as plain text. Values are only ever placed in text
 * nodes by the caller, so nothing here can become markup.
 */
export function describeValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') {
    const text = ISO_TIMESTAMP.test(value) ? formatCalendarDate(value) : value;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (depth < 2 && typeof value === 'object' && !Array.isArray(value) && ('from' in value || 'to' in value)) {
    const change = value as { from?: unknown; to?: unknown };
    return `${describeValue(change.from, depth + 1)} → ${describeValue(change.to, depth + 1)}`;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  } catch {
    return 'Unreadable value';
  }
}

/** key/value pairs of a details object, capped so one odd record can't flood the page */
export function detailEntries(details: Record<string, unknown> | null | undefined): Array<{ key: string; label: string; value: string }> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  return Object.entries(details)
    .slice(0, 20)
    .map(([key, value]) => ({ key, label: humanizeKey(key), value: describeValue(value) }));
}

const KYC_ACTIONS: Record<string, string> = {
  KYC_DECISION: 'KYC decision',
  IDENTITY_CHANGED: 'Identity details changed',
  IDENTITY_CHANGED_KYC_RESET: 'Identity details changed, KYC sent back for review',
};

export const kycActionLabel = (action: string) => KYC_ACTIONS[action] ?? humanize(action);

export const KYC_LABEL = { PENDING: 'Pending review', VERIFIED: 'Verified', REJECTED: 'Rejected' } as const;

export const ALERT_STATUS_LABEL = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
} as const;

/** Fraud rule reasons start with the side of the transaction that was scored: "[OUTBOUND] Amount ..." */
export function splitReason(reason: string): { direction: 'Outgoing' | 'Incoming' | null; text: string } {
  const match = /^\[(OUTBOUND|INBOUND)\]\s*/.exec(reason);
  if (!match) return { direction: null, text: reason };
  return { direction: match[1] === 'OUTBOUND' ? 'Outgoing' : 'Incoming', text: reason.slice(match[0].length) || reason };
}

// --- Fraud alert reasons --------------------------------------------------------------------------

export interface AlertReason {
  /** A short name for the signal: "Large transaction" (or the rule's own text when it isn't recognised) */
  title: string;
  /** The specifics in plain words, or null when there is nothing more to say */
  detail: string | null;
  /** The rule's text as the service recorded it, without the direction tag */
  text: string;
}

export interface DescribedAlert {
  direction: 'Outgoing' | 'Incoming' | null;
  reasons: AlertReason[];
  /** What the alert is about, for list titles and the page title */
  headline: string;
  /** Every reason matched a known rule (otherwise the headline is the raw text) */
  known: boolean;
  /** The flagged transaction's amount, when a rule states it ("₹2,50,000.00") */
  amount: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 60 → "1 minute", 300 → "5 minutes", 45 → "45 seconds", 3600 → "1 hour" */
function duration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

const RUPEES = '₹[\\d,]+(?:\\.\\d{1,2})?';

/** The fraud service's rules, one sentence each (see backend fraud-service src/rules) */
const RULES: Array<{ pattern: RegExp; describe: (m: RegExpExecArray) => { title: string; detail: string | null; amount?: string } }> = [
  {
    pattern: new RegExp(`^Transaction amount (${RUPEES}) exceeds threshold limit of (${RUPEES})$`),
    describe: (m) => ({ title: 'Large transaction', detail: `${m[1]}, over the ${m[2]} threshold`, amount: m[1] }),
  },
  {
    pattern: /^Excessive transaction frequency: (\d+) transactions recorded within (\d+)s$/,
    describe: (m) => ({ title: 'Rapid transactions', detail: `${m[1]} transactions in ${duration(Number(m[2]))}` }),
  },
  {
    pattern: /^(\d+) cash operations just below the approval limit (by the same initiator|on one account) within (\d+)h$/,
    describe: (m) => ({
      title: 'Cash structuring',
      detail: `${m[1]} cash operations just below the approval limit ${m[2] === 'on one account' ? 'on this account' : 'by the same staff member'} in ${plural(Number(m[3]), 'hour')}`,
    }),
  },
  {
    pattern: /^(\d+) cash operations (by the same initiator on one account|on one account) total (\d+) paise within (\d+)h, above the single-approval limit$/,
    describe: (m) => ({
      title: 'Split cash operations',
      detail: `${m[1]} cash operations ${m[2] === 'on one account' ? 'on this account' : 'by the same staff member'} totalling ${formatPaise(m[3])} in ${plural(Number(m[4]), 'hour')}, above the single-approval limit`,
    }),
  },
  { pattern: /^Multiple risk anomalies detected$/, describe: () => ({ title: 'Several risk signals', detail: null }) },
];

const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/**
 * Turns an alert's recorded reason ("[INBOUND] Transaction amount ₹2,50,000.00 exceeds threshold limit of
 * ₹2,00,000.00 | Excessive transaction frequency: …") into words for people: the direction on its own,
 * one line per signal, and a short name for the whole alert. Text that matches no known rule is kept as is.
 */
export function describeAlertReason(reason: string): DescribedAlert {
  const { direction, text } = splitReason(reason.trim());
  let amount: string | null = null;
  let known = true;
  const reasons: AlertReason[] = text
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      for (const rule of RULES) {
        const match = rule.pattern.exec(part);
        if (!match) continue;
        const described = rule.describe(match);
        amount ??= described.amount ?? null;
        return { title: described.title, detail: described.detail, text: part };
      }
      known = false;
      return { title: part, detail: null, text: part };
    });

  const titles = [...new Set(reasons.map((r) => r.title))];
  const headline =
    titles.length === 0
      ? 'Risk alert'
      : titles.length === 1
        ? titles[0]!
        : titles.length === 2
          ? `${titles[0]} and ${lowerFirst(titles[1]!)}`
          : `${titles[0]} and ${titles.length - 1} other signals`;
  return { direction, reasons, headline, known: known && reasons.length > 0, amount };
}

// --- Times in lists -------------------------------------------------------------------------------

const clean = (text: string) => text.replace(/[\u202f\u00a0]/g, ' ');

/**
 * A compact time for a row, as Mail shows it: the time today, "Yesterday, 9:10 pm", "20 Oct" this year,
 * "31 Dec 2025" before. The full timestamp belongs in the element's title.
 */
export function formatListTime(iso: string | null | undefined, now: number = Date.now(), timeZone?: string): string {
  const date = toDate(iso);
  if (!date) return '—';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = day.format(now);
  const yesterday = day.format(now - 24 * 3600_000);
  const key = day.format(date);
  const time = clean(new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date));
  if (key === today) return time;
  if (key === yesterday) return `Yesterday, ${time}`;
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return clean(new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }).format(date));
}
