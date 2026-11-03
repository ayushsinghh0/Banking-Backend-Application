import type { BadgeTone } from '@/components/ui/primitives';
import type { RiskLevel } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';

/**
 * Fraud alert reasons arrive as the fraud service writes them:
 * "[INBOUND] Transaction amount ₹6,00,000.00 exceeds threshold limit of ₹2,00,000.00 | Excessive transaction …".
 * This turns them into a short title, one plain sentence per signal, and the direction of the money.
 */
export interface AlertDescription {
  /** Which way the money was moving on the flagged account, when the service says */
  direction: 'Incoming' | 'Outgoing' | null;
  /** "Large amount", "Large amount and rapid transactions" */
  title: string;
  /** One sentence per signal; empty when the title already says everything */
  reasons: string[];
}

interface Signal {
  title: string;
  sentence: string;
  known: boolean;
}

const plural = (n: string, word: string) => `${n} ${word}${n === '1' ? '' : 's'}`;

/** "60" -> "1 minute", "45" -> "45 seconds" */
function span(secondsText: string): string {
  const seconds = Number(secondsText);
  if (seconds >= 60 && seconds % 60 === 0) return plural(String(seconds / 60), 'minute');
  return plural(secondsText, 'second');
}

const RULES: Array<{ pattern: RegExp; title: string; sentence: (m: RegExpExecArray) => string }> = [
  {
    pattern: /^Transaction amount (.+?) exceeds threshold limit of (.+)$/i,
    title: 'Large amount',
    sentence: (m) => `${m[1]} is over the ${m[2]} limit`,
  },
  {
    pattern: /^Excessive transaction frequency: (\d+) transactions? recorded within (\d+)s$/i,
    title: 'Rapid transactions',
    sentence: (m) => `${plural(m[1]!, 'transaction')} within ${span(m[2]!)}`,
  },
  {
    pattern: /^(\d+) cash operations just below the approval limit by the same initiator within 24h$/i,
    title: 'Possible structuring',
    sentence: (m) => `${m[1]} cash operations just under the approval limit by one teller in 24 hours`,
  },
  {
    pattern: /^(\d+) cash operations by the same initiator on one account total (\d+) paise within 24h, above the single-approval limit$/i,
    title: 'Possible structuring',
    sentence: (m) => `${m[1]} cash operations by one teller on this account, ${formatPaise(m[2])} in 24 hours, above the single-approval limit`,
  },
  {
    pattern: /^(\d+) cash operations just below the approval limit on one account within 24h$/i,
    title: 'Possible structuring',
    sentence: (m) => `${m[1]} cash operations just under the approval limit on this account in 24 hours`,
  },
  {
    pattern: /^(\d+) cash operations on one account total (\d+) paise within 24h, above the single-approval limit$/i,
    title: 'Possible structuring',
    sentence: (m) => `${m[1]} cash operations on this account, ${formatPaise(m[2])} in 24 hours, above the single-approval limit`,
  },
];

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function signal(part: string): Signal | null {
  if (/^multiple risk anomalies detected$/i.test(part)) return { title: 'Several risk signals', sentence: '', known: true };
  for (const rule of RULES) {
    const match = rule.pattern.exec(part);
    if (match) return { title: rule.title, sentence: rule.sentence(match), known: true };
  }
  // A rule this screen doesn't know yet: the service's own words are better than nothing
  const text = sentenceCase(part);
  return { title: text, sentence: text, known: false };
}

export function describeAlertReason(reason: string): AlertDescription {
  const prefix = /^\s*\[(INBOUND|OUTBOUND)\]\s*/i.exec(reason);
  const direction = prefix ? (prefix[1]!.toUpperCase() === 'INBOUND' ? 'Incoming' : 'Outgoing') : null;
  const body = prefix ? reason.slice(prefix[0].length) : reason;
  const signals = body
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(signal)
    .filter((s): s is Signal => s !== null);

  if (signals.length === 0) return { direction, title: 'Unusual activity', reasons: [] };

  const titles = [...new Set(signals.map((s) => s.title))];
  const title =
    titles.length === 1
      ? titles[0]!
      : titles.length === 2
        ? `${titles[0]} and ${titles[1]!.charAt(0).toLowerCase()}${titles[1]!.slice(1)}`
        : `${titles[0]} and ${titles.length - 1} other signals`;
  // A lone unrecognised reason is already the title: don't repeat it underneath
  const reasons = signals.length === 1 && !signals[0]!.known ? [] : signals.map((s) => s.sentence).filter(Boolean);
  return { direction, title, reasons };
}

/** Red is kept for critical risk; high risk needs attention (amber); the rest are informational */
export function severityTone(severity: RiskLevel): BadgeTone {
  if (severity === 'CRITICAL') return 'danger';
  if (severity === 'HIGH') return 'warning';
  return 'neutral';
}
