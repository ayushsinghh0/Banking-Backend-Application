import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Mail, X } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/data';
import { Card, PageHeader } from '@/components/ui/primitives';
import { LoadingAnnouncement } from './components/LoadingAnnouncement';
import { NotificationTable } from './components/NotificationTable';
import { useListParams } from './components/hooks';

const LIMIT = 20;
const MAX_RECIPIENT = 254;

/** The log matches recipients exactly; addresses are stored lower-case */
const normaliseRecipient = (value: string) => {
  const trimmed = value.trim();
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
};

export default function NotificationsPage() {
  const api = useApi();
  const fieldId = useId();
  const { params, update, offset } = useListParams();
  const recipient = params.get('recipient') ?? '';
  const [draft, setDraft] = useState(recipient);
  const [error, setError] = useState<string>();

  const filters = { recipient, limit: LIMIT, offset };
  const query = useQuery({
    queryKey: qk.notificationLogs(filters),
    queryFn: () => api.notifications.logs({ ...filters, recipient: recipient || undefined }),
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as { recipient?: string } | undefined)?.recipient === recipient ? previous : undefined,
  });
  const rows = query.data;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = normaliseRecipient(draft);
    if (next.length > MAX_RECIPIENT) {
      setError('Addresses are at most 254 characters');
      return;
    }
    setError(undefined);
    setDraft(next);
    update({ recipient: next, offset: undefined });
  };

  const clear = () => {
    setDraft('');
    setError(undefined);
    update({ recipient: undefined, offset: undefined });
  };

  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title="Notification log" description="Every email the bank sent, newest first. Open one to read it." />
      <form onSubmit={apply} noValidate role="search" aria-label="Filter notifications" className="space-y-2">
        <div className="flex gap-2 sm:gap-3">
          <div className="relative min-w-0 flex-1 sm:max-w-[26rem]">
            <label htmlFor={fieldId} className="sr-only">
              Recipient
            </label>
            <Mail className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id={fieldId}
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              placeholder="Recipient’s email address"
              value={draft}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${errorId} ${hintId}` : hintId}
              onChange={(e) => setDraft(e.target.value)}
              className={cn(
                'flex h-12 w-full rounded-full bg-card pl-11 text-base text-foreground shadow-card transition-[box-shadow] duration-150 placeholder:text-muted-foreground hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 sm:text-[16px]',
                recipient ? 'pr-12' : 'pr-4',
                error && 'ring-2 ring-destructive'
              )}
            />
            {recipient ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={clear}
                className="absolute inset-y-0 right-0 flex w-12 cursor-pointer items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-[18px] items-center justify-center rounded-full bg-muted-foreground/60 text-card">
                  <X className="size-3" strokeWidth={3} aria-hidden="true" />
                </span>
              </button>
            ) : null}
          </div>
          <Button type="submit" variant="secondary" size="lg" className="shrink-0 bg-card px-5 shadow-card hover:bg-card hover:shadow-raised">
            Filter
          </Button>
        </div>
        {error ? (
          <p id={errorId} role="alert" className="flex items-center gap-1.5 px-1 text-[13px] font-medium text-destructive">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}
        <p id={hintId} className="px-1 text-[13px] text-muted-foreground">
          Matches the exact address, e.g. asha@example.in
        </p>
      </form>
      <Card className="overflow-hidden">
        <LoadingAnnouncement active={query.isFetching} label="Loading notifications…" />
        <NotificationTable
          rows={rows}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          empty={
            recipient
              ? { title: `No notifications to ${recipient}`, description: 'The filter matches the exact address. Check it for typos.' }
              : { title: 'No notifications yet', description: 'Emails appear here as soon as they are sent.' }
          }
        />
        {rows && (rows.length > 0 || offset > 0) ? (
          <Pagination offset={offset} limit={LIMIT} count={rows.length} onChange={(next) => update({ offset: next })} />
        ) : null}
      </Card>
    </div>
  );
}
