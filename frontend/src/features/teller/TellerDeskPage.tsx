import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, Hourglass, Inbox, RotateCw, type LucideIcon } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { cn } from '@/lib/cn';
import type { TellerSession } from '@/lib/api/types';
import { Discrepancy, PAGE_SIZE, formatBusinessDate, formatDateTime, formatTimeOnDay, istToday } from '@/features/branch/components/cash';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Amount, Callout, Card, DescriptionList, PageHeader, Skeleton } from '@/components/ui/primitives';
import { CashDesk } from './components/CashDesk';
import { AcceptFloatForm, DeclareCountForm } from './components/CountForms';

/** How often the desk checks for a supervisor's action while the teller is waiting on one */
const POLL_MS = 15_000;

export default function TellerDeskPage() {
  const api = useApi();
  const query = useQuery({
    queryKey: qk.tellerSession,
    queryFn: () => api.teller.currentSession(),
    // Nothing changes under an open desk except the teller's own actions; every other state waits on a supervisor
    refetchInterval: (q) => (q.state.data?.status === 'OPEN' ? false : POLL_MS),
  });
  const session = query.data ?? null;
  // An open desk uses the full width; every other state is one calm, centred column
  const narrow = query.isSuccess && session?.status !== 'OPEN';

  return (
    <div className={cn('space-y-6 lg:space-y-8', narrow && 'mx-auto max-w-2xl')}>
      <PageHeader
        title="Cash desk"
        description={session ? `Business date ${formatBusinessDate(session.businessDate)}` : 'Your cash session for the business day.'}
      />
      {query.isPending ? (
        <Card className="space-y-4 p-6 sm:p-8">
          <p role="status" className="sr-only">
            Loading your cash session…
          </p>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-12 w-full max-w-sm" />
        </Card>
      ) : query.isError && query.data === undefined ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : (
        <SessionView session={session} checking={query.isFetching} onCheck={() => void query.refetch()} />
      )}
    </div>
  );
}

/** A state the teller waits in: a bare glyph, a headline and what happens next */
function StatusTile({
  icon: Icon,
  iconClassName,
  title,
  children,
  footer,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="px-6 py-10 text-center sm:px-10 sm:py-12">
      <Icon className={cn('mx-auto size-10 text-muted-foreground', iconClassName)} strokeWidth={1.5} aria-hidden="true" />
      <h2 className="mt-4 text-title-3">{title}</h2>
      <div className="mx-auto mt-2 max-w-md space-y-2 text-pretty text-[15px] leading-[22px] text-muted-foreground">{children}</div>
      {footer}
    </Card>
  );
}

function SessionView({ session, checking, onCheck }: { session: TellerSession | null; checking: boolean; onCheck: () => void }) {
  if (!session) {
    return (
      <StatusTile
        icon={Inbox}
        title="No float issued yet"
        footer={
          <Button variant="secondary" className="mt-6" onClick={onCheck} aria-busy={checking || undefined}>
            <RotateCw aria-hidden="true" className={checking ? 'animate-spin' : undefined} /> Check now
          </Button>
        }
      >
        <p>Ask your supervisor to issue today’s opening float. This page checks for it every 15 seconds.</p>
      </StatusTile>
    );
  }

  switch (session.status) {
    case 'ISSUED':
      return (
        <Card className="p-6 sm:p-8">
          <h2 className="text-title-3">Count your opening float</h2>
          <p className="mt-2 text-pretty text-[15px] leading-[22px] text-muted-foreground">
            Your supervisor has issued your float. Count every note and coin you were handed and enter the total. The issued amount isn’t
            shown, so your count is independent.
          </p>
          <div className="mt-6">
            <AcceptFloatForm />
          </div>
        </Card>
      );
    case 'OPEN':
      return <OpenDesk session={session} />;
    case 'CLOSED':
      return <AwaitingSignOff session={session} />;
    case 'RECONCILED':
      return (
        <StatusTile
          icon={CheckCircle2}
          iconClassName="text-success"
          title="You’re done for the day"
          footer={
            session.declaredClosing ? (
              <DescriptionList
                className="mx-auto mt-6 max-w-sm border-t border-border/70 text-left"
                items={[
                  { label: 'Your count', value: <Amount paise={session.declaredClosing} /> },
                  ...(session.expectedClosing ? [{ label: 'Expected', value: <Amount paise={session.expectedClosing} /> }] : []),
                  ...(session.discrepancy !== undefined && session.discrepancy !== null
                    ? [{ label: 'Difference', value: <Discrepancy paise={session.discrepancy} /> }]
                    : []),
                ]}
              />
            ) : null
          }
        >
          <p>Day closed and signed off at {formatDateTime(session.signedOffAt)}.</p>
          <p>Your next float will appear here when it’s issued.</p>
        </StatusTile>
      );
    case 'CANCELLED':
      return (
        <StatusTile icon={Ban} title="Float cancelled">
          <p>
            Your supervisor cancelled the float issued for {formatBusinessDate(session.businessDate)}. Hand back any cash you received from
            it.
          </p>
          <p>A new float will appear here when it’s issued. This page checks every 15 seconds.</p>
        </StatusTile>
      );
    default:
      return null;
  }
}

function OpenDesk({ session }: { session: TellerSession }) {
  const api = useApi();
  const stale = session.businessDate < istToday();
  // Operations still awaiting a supervisor block closing: say so before the teller counts the drawer
  const pending = useQuery({
    queryKey: qk.cashOperations('PENDING_APPROVAL', 0),
    queryFn: () => api.teller.cashOperations({ status: 'PENDING_APPROVAL', limit: PAGE_SIZE, offset: 0 }),
    refetchInterval: (q) => (q.state.data?.length ? POLL_MS : false),
  });
  const waiting = pending.data?.length ?? 0;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start lg:gap-6">
      {stale ? (
        <Callout tone="warning" title="This session is from a previous business day" className="lg:col-span-8">
          It was opened for {formatBusinessDate(session.businessDate)}. Close it with your end-of-day count before you handle any cash today.
        </Callout>
      ) : (
        <Card className="p-5 sm:p-6 lg:col-span-8 lg:p-8">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-title-3">Serve a customer</h2>
            <p className="text-[13px] text-muted-foreground">
              Open since <span className="tnum">{formatTimeOnDay(session.acceptedAt ?? session.openedAt, session.businessDate)}</span>
            </p>
          </div>
          <CashDesk />
        </Card>
      )}
      <Card className="p-5 sm:p-6 lg:col-span-4">
        <h2 className="text-headline">End of day</h2>
        <p className="mt-1 text-pretty text-[14px] leading-5 text-muted-foreground">
          After your last customer, count all the cash in your drawer and declare the total. A supervisor then counts it independently to sign
          off.
        </p>
        <div className="mt-5 space-y-4">
          {waiting > 0 ? (
            <Callout
              tone="warning"
              title={`${waiting >= PAGE_SIZE ? `${PAGE_SIZE} or more operations are` : waiting === 1 ? '1 operation is' : `${waiting} operations are`} waiting for a supervisor`}
            >
              <p>A supervisor must approve or reject them before you can close.</p>
              <p>
                <Link to="/teller/operations" className="font-medium text-primary underline-offset-2 hover:underline">
                  Review My operations
                </Link>
              </p>
            </Callout>
          ) : null}
          <DeclareCountForm
            label="Cash in drawer"
            submitLabel="Close session"
            confirmTitle="Close your cash session?"
            confirmDescription={(amount) =>
              `You’re declaring ${amount} in your drawer. After closing you can’t take deposits or pay out withdrawals. Your supervisor will count the drawer independently to sign off.`
            }
            confirmLabel="Declare and close"
            successTitle="Session closed"
            successDescription="Your supervisor will now count and sign off."
          />
        </div>
      </Card>
    </div>
  );
}

function AwaitingSignOff({ session }: { session: TellerSession }) {
  const [redeclaring, setRedeclaring] = useState(false);
  return (
    <StatusTile
      icon={Hourglass}
      title="Waiting for supervisor sign-off"
      footer={
        redeclaring ? (
          <div className="mx-auto mt-6 max-w-sm space-y-4 border-t border-border/70 pt-6 text-left">
            <p className="text-headline">Correct your count</p>
            <DeclareCountForm
              label="Corrected cash count"
              submitLabel="Re-declare count"
              confirmTitle="Replace your declared count?"
              confirmDescription={(amount) =>
                `Your new count of ${amount} replaces the one you declared earlier. Your supervisor still counts independently before signing off.`
              }
              confirmLabel="Replace count"
              successTitle="Count updated"
              successDescription="Your supervisor will count against your corrected figure."
              onDone={() => setRedeclaring(false)}
            />
            <Button variant="ghost" block onClick={() => setRedeclaring(false)}>
              Keep my count
            </Button>
          </div>
        ) : (
          <div className="mt-6 flex flex-col items-center gap-1 sm:flex-row sm:justify-center sm:gap-2">
            <p className="text-[14px] text-muted-foreground">Miscounted?</p>
            <Button variant="link" onClick={() => setRedeclaring(true)}>
              Re-declare your count
            </Button>
          </div>
        )
      }
    >
      <p>You declared your closing count at {formatDateTime(session.closedAt)}.</p>
      <p>A supervisor will count your drawer independently and sign off. Keep the drawer sealed until then. This page updates automatically.</p>
    </StatusTile>
  );
}
