import { useId } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { formatPaise } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import type { PaymentsSummary } from '../api';
import { formatRate, formatSeconds, summaryFigures } from '../format';
import { KeyFigures, type Figure } from './KeyFigures';

const plural = (n: number, word: string) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`;

const CRORE_PAISE = 1_000_000_000n;
const crores = new Intl.NumberFormat('en-IN');

/**
 * Rupees with the paise quieter. From a crore up, a day's volume reads "₹98.77 Cr" so it fits its column; the
 * exact amount is in the tooltip and read out by screen readers.
 */
function Rupees({ paise }: { paise: string }) {
  const exact = formatPaise(paise);
  const amount = BigInt(paise);
  if (amount >= CRORE_PAISE) {
    const hundredths = (amount * 100n) / CRORE_PAISE;
    const compact = `₹${crores.format(hundredths / 100n)}.${(hundredths % 100n).toString().padStart(2, '0')} Cr`;
    return (
      <span title={exact}>
        <span aria-hidden="true">{compact}</span>
        <span className="sr-only">{exact}</span>
      </span>
    );
  }
  const dot = exact.lastIndexOf('.');
  return (
    <span className="[overflow-wrap:anywhere]">
      {exact.slice(0, dot)}
      <span className="text-muted-foreground/70">{exact.slice(dot)}</span>
    </span>
  );
}

/** Today's top-ups at a glance (IST business day), and the one thing that needs an administrator */
export function PaymentSummary({ query, onShowBlocked }: { query: UseQueryResult<PaymentsSummary>; onShowBlocked: () => void }) {
  const headingId = useId();
  const summary = query.data;
  const figures = summary ? summaryFigures(summary) : null;

  const list: Figure[] = [
    {
      id: 'volume',
      label: 'Credited today',
      value: figures ? <Rupees paise={figures.creditedPaise} /> : null,
      hint: figures ? plural(figures.creditedCount, 'top-up') : null,
    },
    {
      id: 'count',
      label: 'Top-ups today',
      value: figures ? figures.total.toLocaleString('en-IN') : null,
      hint: figures ? (figures.open ? `${figures.open.toLocaleString('en-IN')} in progress` : 'None in progress') : null,
    },
    {
      id: 'rate',
      label: 'Success rate',
      value: formatRate(summary?.successRate ?? null),
      hint: summary?.successRate === null ? 'Nothing finished yet' : 'Of top-ups finished today',
    },
    {
      id: 'median',
      label: 'Median time to credit',
      value: formatSeconds(summary?.medianSecondsToCredit ?? null),
      hint: 'From order to credit',
    },
  ];

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="sr-only">
        Today
      </h2>
      <KeyFigures
        figures={list}
        loading={query.isPending}
        error={query.isError && !summary}
        onRetry={() => void query.refetch()}
        retryLabel="Try again loading today’s figures"
      />
      {figures && figures.blocked > 0 ? (
        <Callout
          tone="warning"
          title={`${plural(figures.blocked, 'top-up')} couldn’t be credited`}
          action={
            <Button variant="secondary" size="sm" onClick={onShowBlocked}>
              Show them
            </Button>
          }
        >
          The customer paid, but the account was frozen or closed, or the amount didn’t match. Refund them so the money goes back.
        </Callout>
      ) : null}
    </section>
  );
}
