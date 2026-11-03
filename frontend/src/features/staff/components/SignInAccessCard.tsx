import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { notifyError, notifySuccess } from '@/lib/notify';
import type { DirectoryUser } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Skeleton, StatusBadge } from '@/components/ui/primitives';
import { hasCode, isRefusal } from './hooks';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';
import { Facts, Panel } from './layout';

const directoryParams = (userId: string) => ({ q: userId, limit: 5 });

/** The sign-in account behind a customer id, from the staff directory (null when it isn't listed) */
export function useDirectoryUser(userId: string, enabled: boolean): UseQueryResult<DirectoryUser | null> {
  const api = useApi();
  const params = directoryParams(userId);
  return useQuery({
    queryKey: qk.directory(params),
    queryFn: async () => (await api.admin.users(params)).find((u) => u.id === userId) ?? null,
    enabled,
  });
}

type Action = 'disable' | 'enable' | 'reset';

/** An action as a row of the tile, as in Settings: blue for ordinary actions, red for destructive ones */
function ActionRow({ destructive, onClick, children }: { destructive?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-12 w-full cursor-pointer items-center text-left text-[15px] tracking-[-0.01em] transition-opacity hover:opacity-70 focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring',
        destructive ? 'text-destructive' : 'text-primary'
      )}
    >
      {children}
    </button>
  );
}

/**
 * Sign-in status for support and administrators; administrators can suspend or reinstate sign-in and reset
 * the authenticator. Customer suspensions apply at once; anything the API turns into a four-eyes request
 * (202) is reported as waiting for a second administrator.
 */
export function SignInAccessCard({
  userId,
  name,
  query,
  canManage,
  me,
  className,
}: {
  userId: string;
  name: string;
  query: UseQueryResult<DirectoryUser | null>;
  canManage: boolean;
  me: string;
  className?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const target = query.data ?? null;
  const known = query.isSuccess && target !== null;

  const run = async (current: Action) => {
    setOutcome(null);
    try {
      const result = current === 'reset' ? await api.admin.resetMfa(userId) : await api.admin.setUserActive(userId, current === 'enable');
      if (result.queued) {
        setOutcome({
          tone: 'info',
          title: 'Sent for approval',
          body: (
            <>
              Another administrator must approve this in{' '}
              <Link to="/approvals" className="font-medium text-primary underline-offset-2 hover:underline">
                Approvals
              </Link>{' '}
              before it takes effect.
            </>
          ),
        });
      } else if (current === 'reset') {
        notifySuccess('Authenticator reset', `${name} will set up a new authenticator at their next sign-in.`);
      } else {
        if (target) queryClient.setQueryData(qk.directory(directoryParams(userId)), { ...target, isActive: current === 'enable' });
        notifySuccess(
          current === 'enable' ? 'Sign-in enabled' : 'Sign-in disabled',
          current === 'enable' ? `${name} can sign in again.` : `${name} has been signed out everywhere.`
        );
      }
      void queryClient.invalidateQueries({ queryKey: qk.directoryAll });
      void queryClient.invalidateQueries({ queryKey: qk.adminRequestsAll });
    } catch (error) {
      if (!isRefusal(error)) {
        notifyError(error);
        throw error;
      }
      if (current === 'enable' && hasCode(error, 'FORBIDDEN')) {
        setOutcome({
          tone: 'danger',
          title: 'A different administrator must re-enable sign-in',
          body: 'Dual control: a customer you disabled can only be re-enabled by another administrator.',
        });
      } else {
        setOutcome(outcomeFromError(error));
      }
    }
  };

  const dialogs = {
    disable: {
      title: `Disable sign-in for ${name}?`,
      description:
        'They’re signed out on every device straight away and can’t sign in until sign-in is enabled again. Their accounts and money aren’t changed. Dual control applies: a different administrator will have to re-enable it.',
      confirmLabel: 'Disable sign-in',
      tone: 'destructive' as const,
    },
    enable: {
      title: `Enable sign-in for ${name}?`,
      description: 'They’ll be able to sign in again. If you disabled them yourself, a different administrator must do this.',
      confirmLabel: 'Enable sign-in',
      tone: 'primary' as const,
    },
    reset: {
      title: `Reset ${name}’s authenticator?`,
      description:
        'Their current authenticator app stops working and they’ll set up a new one at their next sign-in. Only do this after confirming who you’re dealing with. A second administrator may need to approve it.',
      confirmLabel: 'Request reset',
      tone: 'destructive' as const,
    },
  };
  const dialog = action ? dialogs[action] : null;
  const self = userId === me;

  return (
    <Panel title="Sign-in & security" description="The customer’s online banking login." className={className} bodyClassName="space-y-4">
      {query.isPending ? (
        <div className="space-y-3 pt-1" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : known ? (
        <Facts
          items={[
            {
              label: 'Email',
              value: (
                <span className="block truncate" title={target.email}>
                  {target.email}
                </span>
              ),
            },
            {
              label: 'Sign-in',
              value: <StatusBadge status={target.isActive ? 'ACTIVE' : 'DISABLED'} label={target.isActive ? 'Enabled' : 'Disabled'} />,
            },
            { label: 'Authenticator', value: target.mfaEnabled ? 'On' : 'Off' },
            { label: 'Email verified', value: target.isEmailVerified ? 'Yes' : 'No' },
          ]}
        />
      ) : (
        <p className="text-[14px] leading-5 text-muted-foreground">
          {query.isError ? 'Sign-in status couldn’t be loaded.' : 'Sign-in status isn’t available for this customer.'}
        </p>
      )}
      {known ? (
        <Link
          to={`/notifications?${new URLSearchParams({ recipient: target.email }).toString()}`}
          className="-mx-2 flex h-11 items-center justify-between rounded-xl px-2 text-[15px] tracking-[-0.01em] text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Emails sent to this customer
          <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true" />
        </Link>
      ) : null}
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      {canManage && !query.isPending ? (
        self ? (
          <p className="text-[14px] leading-5 text-muted-foreground">You can’t change your own sign-in. Another administrator would have to.</p>
        ) : (
          <div>
            <div className="divide-y divide-border/70 border-y border-border/70">
              {!known || target.mfaEnabled ? <ActionRow onClick={() => setAction('reset')}>Reset authenticator</ActionRow> : null}
              {!known || !target.isActive ? <ActionRow onClick={() => setAction('enable')}>Enable sign-in</ActionRow> : null}
              {!known || target.isActive ? (
                <ActionRow destructive onClick={() => setAction('disable')}>
                  Disable sign-in
                </ActionRow>
              ) : null}
            </div>
            <p className="mt-3 text-[13px] leading-[18px] text-muted-foreground">
              Dual control: if you disable sign-in, a different administrator must re-enable it.
            </p>
          </div>
        )
      ) : null}
      {dialog ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          title={dialog.title}
          description={dialog.description}
          confirmLabel={dialog.confirmLabel}
          tone={dialog.tone}
          onConfirm={() => run(action!)}
        />
      ) : null}
    </Panel>
  );
}
