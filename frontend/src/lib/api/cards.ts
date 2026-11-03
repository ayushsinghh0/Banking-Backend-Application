import type { AssistantCard, TopUpStatus } from './types';

/*
 * Sphere's answer cards come from a language model's tool calls, relayed by the assistant service. They are
 * data, never markup: every card is checked field by field here, rows that don't fit are dropped, and a card
 * of an unknown type is ignored, so nothing the model says can change how the app behaves.
 */

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** Integer paise, as a string; numbers are accepted when they are safe integers */
function paise(value: unknown): string | null {
  if (typeof value === 'string' && /^-?\d{1,18}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function rows<T>(value: unknown, read: (row: Raw) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((row) => {
    const item = isObject(row) ? read(row) : null;
    return item ? [item] : [];
  });
}

function direction(value: unknown): 'CREDIT' | 'DEBIT' | null {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (v === 'credit' || v === 'in') return 'CREDIT';
  if (v === 'debit' || v === 'out') return 'DEBIT';
  return null;
}

const TOP_UP_STATUSES = new Set<TopUpStatus>([
  'CREATED',
  'PENDING',
  'CAPTURED',
  'CREDITED',
  'CREDIT_BLOCKED',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
]);

const readers: { [K in AssistantCard['type']]: (raw: Raw) => Extract<AssistantCard, { type: K }> | null } = {
  accounts: (raw) => {
    const accounts = rows(raw.accounts, (r) => {
      const id = text(r.id);
      const label = text(r.label);
      const last4 = text(r.last4);
      const balancePaise = paise(r.balancePaise);
      return id && label && last4 !== null && balancePaise ? { id, label, last4, balancePaise } : null;
    });
    return accounts ? { type: 'accounts', accounts } : null;
  },
  transactions: (raw) => {
    const items = rows(raw.items, (r) => {
      const id = text(r.id);
      const at = text(r.at);
      const dir = direction(r.direction);
      const amountPaise = paise(r.amountPaise);
      return id && at && dir && amountPaise ? { id, at, description: text(r.description) ?? '', direction: dir, amountPaise } : null;
    });
    return items ? { type: 'transactions', accountLabel: text(raw.accountLabel) ?? '', items } : null;
  },
  spending: (raw) => {
    const inPaise = paise(raw.inPaise);
    const outPaise = paise(raw.outPaise);
    const days = typeof raw.days === 'number' && Number.isFinite(raw.days) ? raw.days : null;
    const byDay =
      rows(raw.byDay, (r) => {
        const date = text(r.date);
        const dayIn = paise(r.inPaise);
        const dayOut = paise(r.outPaise);
        return date && dayIn && dayOut ? { date, inPaise: dayIn, outPaise: dayOut } : null;
      }) ?? [];
    return inPaise && outPaise && days !== null ? { type: 'spending', days, inPaise, outPaise, byDay } : null;
  },
  payees: (raw) => {
    const items = rows(raw.items, (r) => {
      const nickname = text(r.nickname);
      const last4 = text(r.last4);
      return nickname && last4 !== null ? { nickname, last4, active: r.active !== false } : null;
    });
    return items ? { type: 'payees', items } : null;
  },
  topups: (raw) => {
    const items = rows(raw.items, (r) => {
      const id = text(r.id);
      const amountPaise = paise(r.amountPaise);
      const status = text(r.status) as TopUpStatus | null;
      const at = text(r.at);
      return id && amountPaise && status && TOP_UP_STATUSES.has(status) && at ? { id, amountPaise, status, at } : null;
    });
    return items ? { type: 'topups', items } : null;
  },
  transferDraft: (raw) => {
    const fromAccountId = text(raw.fromAccountId);
    if (!fromAccountId) return null;
    const card: Extract<AssistantCard, { type: 'transferDraft' }> = { type: 'transferDraft', fromAccountId };
    const toPayeeNickname = optionalText(raw.toPayeeNickname);
    const amountPaise = paise(raw.amountPaise);
    const note = optionalText(raw.note);
    if (toPayeeNickname) card.toPayeeNickname = toPayeeNickname;
    if (amountPaise && BigInt(amountPaise) > 0n) card.amountPaise = amountPaise;
    if (note) card.note = note;
    return card;
  },
  help: (raw) => {
    const title = text(raw.title);
    const steps = Array.isArray(raw.steps) ? raw.steps.filter((s): s is string => typeof s === 'string') : null;
    return title !== null && steps ? { type: 'help', title, steps } : null;
  },
};

/** A card the app knows how to draw, or null */
export function normalizeCard(value: unknown): AssistantCard | null {
  if (!isObject(value)) return null;
  const type = text(value.type) ?? text(value.kind);
  if (!type || !Object.hasOwn(readers, type)) return null;
  const body = isObject(value.data) ? { ...value, ...value.data } : value;
  return readers[type as AssistantCard['type']](body);
}

export function normalizeCards(value: unknown): AssistantCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((card) => {
    const normalized = normalizeCard(card);
    return normalized ? [normalized] : [];
  });
}
