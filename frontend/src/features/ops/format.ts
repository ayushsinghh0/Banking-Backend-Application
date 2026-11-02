import { formatDistanceStrict } from 'date-fns';
import { describeError, isApiError, type ErrorDescription } from '@/lib/api/errors';
import { humanize, type BadgeTone } from '@/components/ui/primitives';
import { formatDateTime, humanizeKey } from '@/features/staff/components/format';
import { TOP_UP_STATUSES, type PaymentsSummary, type ReconcileReport, type TopUpStatus } from './api';

// --- top-ups -------------------------------------------------------------------------------------

/**
 * Colour only where it means something: green once the money reached the customer, amber where someone has
 * to act (a credit that couldn't land, a refund in flight). Everything else, failures included, stays quiet:
 * a customer abandoning checkout is ordinary, not an error of ours.
 */
export const TOP_UP_STATUS: Record<TopUpStatus, { label: string; tone: BadgeTone }> = {
  CREATED: { label: 'Started', tone: 'neutral' },
  PENDING: { label: 'Awaiting payment', tone: 'neutral' },
  CAPTURED: { label: 'Crediting', tone: 'neutral' },
  CREDITED: { label: 'Credited', tone: 'success' },
  CREDIT_BLOCKED: { label: 'Credit blocked', tone: 'warning' },
  REFUND_PENDING: { label: 'Refund pending', tone: 'warning' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

export const topUpStatusLabel = (status: TopUpStatus) => TOP_UP_STATUS[status]?.label ?? humanize(status);

const METHODS: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet' };

export const methodLabel = (method: string | null | undefined) => (method ? (METHODS[method.toLowerCase()] ?? humanize(method)) : 'Not paid yet');

const SOURCES: Record<string, string> = {
  customer: 'Customer',
  checkout: 'Customer',
  webhook: 'Razorpay webhook',
  reconciler: 'Reconciler',
  admin: 'Administrator',
  system: 'BankSphere',
};

/** Who or what moved a top-up to a status */
export const sourceLabel = (source: string) => SOURCES[source.toLowerCase()] ?? humanize(source);

/** Money that reached a customer's account today, whatever happened after */
const REACHED_ACCOUNT: TopUpStatus[] = ['CREDITED', 'REFUND_PENDING', 'REFUNDED'];
const IN_FLIGHT: TopUpStatus[] = ['CREATED', 'PENDING', 'CAPTURED'];

export interface SummaryFigures {
  creditedPaise: string;
  creditedCount: number;
  total: number;
  open: number;
  blocked: number;
  refundsPending: number;
}

export function summaryFigures(summary: PaymentsSummary): SummaryFigures {
  const totals = summary.byStatus;
  const count = (statuses: readonly TopUpStatus[]) => statuses.reduce((sum, s) => sum + (totals[s]?.count ?? 0), 0);
  const credited = REACHED_ACCOUNT.reduce((sum, s) => sum + BigInt(totals[s]?.amountPaise ?? '0'), 0n);
  return {
    creditedPaise: credited.toString(),
    creditedCount: count(REACHED_ACCOUNT),
    total: count(TOP_UP_STATUSES),
    open: count(IN_FLIGHT),
    blocked: totals.CREDIT_BLOCKED?.count ?? 0,
    refundsPending: totals.REFUND_PENDING?.count ?? 0,
  };
}

// --- numbers -------------------------------------------------------------------------------------

/** 38 → "38 s", 185 → "3 min 5 s", 3720 → "1 h 2 min" */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

const percent = new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 });

export const formatRate = (rate: number | null) => (rate === null ? '—' : percent.format(rate));

/** "Never", "Expired" or "in 30 minutes" */
export function expiryLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  if (at <= now) return 'Expired';
  return formatDistanceStrict(at, now, { addSuffix: true });
}

// --- security ------------------------------------------------------------------------------------

/** The security event types the auth service records (section 9) */
export const SECURITY_EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'SIGN_IN_SUCCEEDED', label: 'Signed in' },
  { value: 'SIGN_IN_FAILED', label: 'Sign-in failed' },
  { value: 'MFA_FAILED', label: 'Wrong authenticator code' },
  { value: 'NEW_DEVICE', label: 'Signed in on a new device' },
  { value: 'SESSION_REVOKED', label: 'Session signed out' },
  { value: 'PASSWORD_CHANGED', label: 'Password changed' },
  { value: 'IP_AUTO_BANNED', label: 'Address banned automatically' },
];

const EVENT_LABELS = new Map(SECURITY_EVENT_TYPES.map((t) => [t.value, t.label]));

export const eventLabel = (type: string) => EVENT_LABELS.get(type) ?? humanize(type);

/** How long a new IP rule lasts; the API takes minutes and no value means until removed */
export const RULE_DURATIONS: Array<{ value: string; label: string; minutes?: number }> = [
  { value: 'never', label: 'Until removed' },
  { value: '60', label: '1 hour', minutes: 60 },
  { value: '1440', label: '24 hours', minutes: 1440 },
  { value: '10080', label: '7 days', minutes: 10080 },
  { value: '43200', label: '30 days', minutes: 43200 },
];

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

function isIpv6(address: string): boolean {
  if (!address.includes(':') || /[^0-9a-f:.]/i.test(address)) return false;
  try {
    // The URL parser implements the full IPv6 grammar (compression, embedded IPv4)
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

export type CidrResult = { ok: true; cidr: string } | { ok: false; error: string };

/**
 * Checks a deny rule before it is sent, with the auth service's limits: IPv4 /8 or narrower, IPv6 /32 or
 * narrower. A bare address becomes a single-address rule. The service still has the last word (staff
 * networks, the administrator's own address).
 */
export function parseCidr(input: string): CidrResult {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Enter an address or range, for example 203.0.113.0/24' };
  const parts = text.split('/');
  const address = parts[0] ?? '';
  const prefixText = parts[1];
  const invalid = { ok: false as const, error: 'Enter a valid IPv4 or IPv6 address or range' };
  if (parts.length > 2) return invalid;
  const v4 = IPV4.test(address);
  if (!v4 && !isIpv6(address)) return invalid;
  const max = v4 ? 32 : 128;
  const min = v4 ? 8 : 32;
  const prefix = prefixText === undefined ? max : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix > max) return { ok: false, error: `Use a prefix from /${min} to /${max}` };
  if (prefix < min) return { ok: false, error: `${v4 ? 'IPv4' : 'IPv6'} ranges wider than /${min} aren’t allowed` };
  return { ok: true, cidr: `${address}/${prefix}` };
}

// --- reconciler report ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const integer = new Intl.NumberFormat('en-IN');

function reportValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? integer.format(value) : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return ISO.test(value) ? formatDateTime(value) : value.slice(0, 200);
  if (Array.isArray(value)) return integer.format(value.length);
  return '—';
}

/** The reconciler's report as label/value rows (one level of nesting, e.g. "Refunds: checked") */
export function reportEntries(report: ReconcileReport): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, value] of Object.entries(report).slice(0, 40)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, inner] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
        rows.push({ key: `${key}.${child}`, label: `${humanizeKey(key)}: ${humanizeKey(child).toLowerCase()}`, value: reportValue(inner) });
      }
    } else {
      rows.push({ key, label: humanizeKey(key), value: reportValue(value) });
    }
  }
  return rows;
}

// --- errors --------------------------------------------------------------------------------------

/** Refusals specific to these pages. The server's own message explains the detail (which range, which rule). */
const OPS_ERRORS: Record<string, { title: string; description?: string }> = {
  // Refunds
  INSUFFICIENT_FUNDS: {
    title: 'Not enough balance to refund',
    description: 'The customer has already spent this money, so it can’t be taken back from their account. Nothing was refunded.',
  },
  TOPUP_NOT_REFUNDABLE: { title: 'This top-up can’t be refunded' },
  INVALID_STATE_TRANSITION: { title: 'This top-up has changed' },
  REFUND_REJECTED: { title: 'Razorpay refused the refund', description: 'The account was not debited. Try again later, or contact Razorpay support.' },
  PROVIDER_UNAVAILABLE: { title: 'Razorpay didn’t respond', description: 'Nothing was refunded. Try again in a moment.' },
  RECONCILE_IN_PROGRESS: { title: 'Already reconciling', description: 'Another run is in progress. Its results appear in the payments list shortly.' },
  // IP rules
  CIDR_TOO_WIDE: { title: 'Range too wide' },
  IP_RULE_TOO_WIDE: { title: 'Range too wide' },
  IP_RULE_OVERLAPS_STAFF_NETWORK: { title: 'Overlaps a staff network' },
  STAFF_NETWORK_OVERLAP: { title: 'Overlaps a staff network' },
  IP_RULE_SELF: { title: 'That’s your own address' },
  OWN_ADDRESS: { title: 'That’s your own address' },
  IP_RULE_EXISTS: { title: 'There’s already a rule for this range' },
};

/** describeError, plus this area's codes; a specific server message is kept rather than replaced */
export function describeOpsError(error: unknown): ErrorDescription {
  const shared = describeError(error);
  if (!isApiError(error)) return shared;
  const entry = OPS_ERRORS[error.code];
  const specific = error.message && error.message !== error.code && error.status >= 400 && error.status < 500 ? error.message : null;
  if (entry) return { title: entry.title, description: entry.description ?? specific ?? shared.description, reference: shared.reference };
  return shared;
}
