import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type { AssistantCard, BankAccount } from '@/lib/api/types';
import { addPaise, comparePaise, formatPaise } from '@/lib/money';
import { qk } from '@/lib/query';
import { maskAccountNumber } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Amount, Avatar, Badge, StatusBadge } from '@/components/ui/primitives';
import { TOP_UP_STATUS_LABEL } from '@/features/customer/topups';

/*
 * Sphere's cards: structured answers drawn with the app's own list patterns. They only ever show data and
 * link to the app's own pages; a transfer draft opens the normal, step-up protected transfer screen.
 */

type Navigate = (to: string) => void;

const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const dateTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const safeFormat = (format: Intl.DateTimeFormat, iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : format.format(date);
};

function Tile({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-2xl bg-card shadow-card">
      <h3 className="px-4 pb-1 pt-3.5 text-[13px] font-semibold text-muted-foreground">{title}</h3>
      {children}
      {footer ? <div className="border-t border-border/70 px-4 py-3">{footer}</div> : null}
    </section>
  );
}

function Row({ leading, title, meta, trailing, onClick }: { leading?: ReactNode; title: ReactNode; meta?: ReactNode; trailing?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{title}</span>
        {meta ? <span className="block truncate text-[13px] text-muted-foreground tnum">{meta}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 flex-col items-end gap-1 text-right">{trailing}</span> : null}
      {onClick ? <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" /> : null}
    </>
  );
  return (
    <li>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-[52px] w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">{body}</div>
      )}
    </li>
  );
}

const rows = 'divide-y divide-border/70 pb-1';

function AccountsCard({ card, onNavigate }: { card: Extract<AssistantCard, { type: 'accounts' }>; onNavigate?: Navigate }) {
  const total = addPaise(card.accounts.map((a) => a.balancePaise));
  return (
    <Tile title="Your accounts" footer={card.accounts.length > 1 ? <TotalLine label="Total" paise={total} /> : undefined}>
      <ul className={rows}>
        {card.accounts.map((account) => (
          <Row
            key={account.id}
            title={account.label}
            meta={`••••${account.last4}`}
            trailing={<span className="tnum text-[15px] font-medium">{formatPaise(account.balancePaise)}</span>}
            onClick={onNavigate ? () => onNavigate(`/accounts/${encodeURIComponent(account.id)}`) : undefined}
          />
        ))}
      </ul>
    </Tile>
  );
}

function TotalLine({ label, paise }: { label: string; paise: string }) {
  return (
    <p className="flex items-center justify-between text-[14px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tnum">{formatPaise(paise)}</span>
    </p>
  );
}

function TransactionsCard({ card }: { card: Extract<AssistantCard, { type: 'transactions' }> }) {
  return (
    <Tile title={card.accountLabel ? `Recent transactions · ${card.accountLabel}` : 'Recent transactions'}>
      {card.items.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-[14px] text-muted-foreground">No transactions yet.</p>
      ) : (
        <ul className={rows}>
          {card.items.map((item) => (
            <Row
              key={item.id}
              title={item.description || (item.direction === 'CREDIT' ? 'Money in' : 'Money out')}
              meta={safeFormat(dateTime, item.at)}
              trailing={<Amount paise={item.amountPaise} direction={item.direction} className="text-[15px]" />}
            />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function SpendingCard({ card }: { card: Extract<AssistantCard, { type: 'spending' }> }) {
  const peak = card.byDay.reduce((max, day) => (comparePaise(day.outPaise, max) > 0 ? day.outPaise : max), '0');
  const peakDay = card.byDay.find((day) => day.outPaise === peak && peak !== '0');
  // Bar heights only: a ratio of two integers is safe to draw with floating point
  const height = (paise: string) => (peak === '0' ? 0 : Math.max(4, Math.round((Number(BigInt(paise) * 1000n / BigInt(peak)) / 1000) * 100)));
  return (
    <Tile title={`Last ${card.days} day${card.days === 1 ? '' : 's'}`}>
      <dl className="grid grid-cols-2 divide-x divide-border/70 px-4 pb-3 pt-1">
        <div className="pr-3">
          <dt className="text-[13px] text-muted-foreground">Money in</dt>
          <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em]">
            <Amount paise={card.inPaise} direction="CREDIT" />
          </dd>
        </div>
        <div className="pl-3">
          <dt className="text-[13px] text-muted-foreground">Money out</dt>
          <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] tnum">{formatPaise(card.outPaise)}</dd>
        </div>
      </dl>
      {card.byDay.length > 1 ? (
        <div
          role="img"
          aria-label={
            peakDay
              ? `Money out per day. Highest: ${formatPaise(peakDay.outPaise)} on ${safeFormat(shortDate, peakDay.date)}.`
              : 'No money went out in this period.'
          }
          className="flex h-16 items-end gap-[3px] px-4 pb-4"
        >
          {card.byDay.map((day) => (
            <span
              key={day.date}
              className={cn('min-w-0 flex-1 rounded-t-[3px]', day.outPaise === '0' ? 'bg-muted' : 'bg-primary/80')}
              style={{ height: `${day.outPaise === '0' ? 4 : height(day.outPaise)}%` }}
            />
          ))}
        </div>
      ) : null}
    </Tile>
  );
}

function PayeesCard({ card, onNavigate }: { card: Extract<AssistantCard, { type: 'payees' }>; onNavigate?: Navigate }) {
  return (
    <Tile
      title="Your payees"
      footer={
        onNavigate ? (
          <button type="button" className="cursor-pointer text-[14px] font-medium text-primary hover:underline" onClick={() => onNavigate('/payees')}>
            Manage payees
          </button>
        ) : undefined
      }
    >
      {card.items.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-[14px] text-muted-foreground">You haven’t added any payees yet.</p>
      ) : (
        <ul className={rows}>
          {card.items.map((payee) => (
            <Row
              key={`${payee.nickname}-${payee.last4}`}
              leading={<Avatar name={payee.nickname} className="size-9" />}
              title={payee.nickname}
              meta={`••••${payee.last4}`}
              trailing={payee.active ? null : <Badge tone="warning">Not active yet</Badge>}
            />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function TopUpsCard({ card, onNavigate }: { card: Extract<AssistantCard, { type: 'topups' }>; onNavigate?: Navigate }) {
  return (
    <Tile
      title="Recent top-ups"
      footer={
        onNavigate ? (
          <button type="button" className="cursor-pointer text-[14px] font-medium text-primary hover:underline" onClick={() => onNavigate('/add-money')}>
            Add money
          </button>
        ) : undefined
      }
    >
      {card.items.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-[14px] text-muted-foreground">No top-ups yet.</p>
      ) : (
        <ul className={rows}>
          {card.items.map((item) => (
            <Row
              key={item.id}
              title={
                item.status === 'CREDITED' ? (
                  <Amount paise={item.amountPaise} direction="CREDIT" />
                ) : (
                  <span className="tnum">{formatPaise(item.amountPaise)}</span>
                )
              }
              meta={safeFormat(dateTime, item.at)}
              trailing={item.status === 'CREDITED' ? null : <StatusBadge status={item.status} label={TOP_UP_STATUS_LABEL[item.status]} />}
            />
          ))}
        </ul>
      )}
    </Tile>
  );
}

const TYPE_NAME: Record<BankAccount['accountType'], string> = { SAVINGS: 'Savings', CURRENT: 'Current' };

/** Where a drafted transfer opens the transfer screen, filled in for the customer to review */
export function transferDraftLink(card: Extract<AssistantCard, { type: 'transferDraft' }>): string {
  const params = new URLSearchParams({ from: card.fromAccountId });
  if (card.toPayeeNickname) params.set('payeeName', card.toPayeeNickname);
  if (card.amountPaise) params.set('amount', card.amountPaise);
  if (card.note) params.set('note', card.note);
  return `/transfer?${params.toString()}`;
}

function TransferDraftCard({ card, onNavigate }: { card: Extract<AssistantCard, { type: 'transferDraft' }>; onNavigate?: Navigate }) {
  const queryClient = useQueryClient();
  const account = queryClient.getQueryData<BankAccount[]>(qk.accounts)?.find((a) => a.id === card.fromAccountId);
  const from = account ? `${TYPE_NAME[account.accountType]} ${maskAccountNumber(account.accountNumber)}` : 'Your account';
  const facts: Array<[string, ReactNode]> = [
    ['From', from],
    ['To', card.toPayeeNickname ?? <span className="text-muted-foreground">Choose on the next screen</span>],
    ['Amount', card.amountPaise ? <span className="tnum">{formatPaise(card.amountPaise)}</span> : <span className="text-muted-foreground">Not set</span>],
  ];
  if (card.note) facts.push(['Note', card.note]);
  return (
    <Tile
      title="Transfer draft"
      footer={
        <div className="space-y-3">
          <p className="text-[13px] leading-[18px] text-muted-foreground">Nothing has been sent. You’ll check the details and confirm the transfer yourself.</p>
          {onNavigate ? (
            <Button size="sm" onClick={() => onNavigate(transferDraftLink(card))}>
              Review transfer <ArrowRight aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
    >
      <dl className="divide-y divide-border/70 px-4 pb-1">
        {facts.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="shrink-0 text-[14px] text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-right text-[15px] font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

function HelpCard({ card }: { card: Extract<AssistantCard, { type: 'help' }> }) {
  return (
    <Tile title={card.title || 'How to'}>
      <ol className="space-y-2.5 px-4 pb-4 pt-1.5">
        {card.steps.map((step, index) => (
          <li key={index} className="flex gap-3 text-[14px] leading-5">
            <span className="w-3 shrink-0 font-semibold text-muted-foreground tnum" aria-hidden="true">
              {index + 1}
            </span>
            <span className="text-pretty">{step}</span>
          </li>
        ))}
      </ol>
    </Tile>
  );
}

/** One card; `onNavigate` (customers) makes rows and actions open the app's pages */
export function AnswerCard({ card, onNavigate }: { card: AssistantCard; onNavigate?: Navigate }) {
  switch (card.type) {
    case 'accounts':
      return <AccountsCard card={card} onNavigate={onNavigate} />;
    case 'transactions':
      return <TransactionsCard card={card} />;
    case 'spending':
      return <SpendingCard card={card} />;
    case 'payees':
      return <PayeesCard card={card} onNavigate={onNavigate} />;
    case 'topups':
      return <TopUpsCard card={card} onNavigate={onNavigate} />;
    case 'transferDraft':
      return <TransferDraftCard card={card} onNavigate={onNavigate} />;
    case 'help':
      return <HelpCard card={card} />;
  }
}
