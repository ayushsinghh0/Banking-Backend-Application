import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, KeyRound, MonitorSmartphone, MoreHorizontal, UserCheck, UserX } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { isApiError } from '@/lib/api/errors';
import type { DirectoryUser } from '@/lib/api/types';
import { notifyError, notifySuccess } from '@/lib/notify';
import { qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

export type UserAction = { kind: 'status' | 'mfa'; user: DirectoryUser };

/** Row menu for an administrator acting on someone else's sign-in */
export function UserActionsMenu({
  user,
  onAction,
  onSessions,
}: {
  user: DirectoryUser;
  onAction: (action: UserAction) => void;
  /** Opens where they're signed in */
  onSessions: (user: DirectoryUser) => void;
}) {
  const customer = user.role === 'CUSTOMER';
  const nothingToReset = customer && !user.mfaEnabled;
  return (
    // Non-modal so the confirmation dialog can take focus as the menu closes
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground max-md:size-11" aria-label={`Actions for ${user.email}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>
          <span className="block truncate">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem destructive={user.isActive} onSelect={() => onAction({ kind: 'status', user })}>
          {user.isActive ? <UserX aria-hidden="true" /> : <UserCheck aria-hidden="true" />}
          {user.isActive ? 'Disable sign-in' : 'Enable sign-in'}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={nothingToReset} onSelect={() => onAction({ kind: 'mfa', user })}>
          <KeyRound aria-hidden="true" />
          Reset authenticator
          {nothingToReset ? <span className="ml-auto pl-3 text-[11.5px] text-muted-foreground">Not set up</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSessions(user)}>
          <MonitorSmartphone aria-hidden="true" />
          Sessions and devices
        </DropdownMenuItem>
        {customer ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to={`/customers/${encodeURIComponent(user.id)}`}>
                <ExternalLink aria-hidden="true" />
                Open customer profile
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActionCopy {
  title: string;
  description: string;
  confirmLabel: string;
  tone: 'primary' | 'destructive';
}

/** What will happen, before it happens. Staff changes and authenticator resets always need a second administrator. */
function actionCopy({ kind, user }: UserAction): ActionCopy {
  const customer = user.role === 'CUSTOMER';
  if (kind === 'mfa') {
    return {
      title: `Request an authenticator reset for ${user.email}?`,
      description: `Removing an authenticator always needs a second administrator. Once approved, their current authenticator stops working, they’re signed out everywhere and they must re-enrol: ${
        customer
          ? 'they can set up two-factor authentication again in their security settings.'
          : 'we email them a one-time link to set up a new authenticator before they can work again.'
      }`,
      confirmLabel: 'Send for approval',
      tone: 'destructive',
    };
  }
  if (user.isActive) {
    return customer
      ? {
          title: `Disable sign-in for ${user.email}?`,
          description:
            'This signs them out on every device immediately. They can’t sign in or bank online until sign-in is enabled again — and a different administrator must re-enable it.',
          confirmLabel: 'Disable sign-in',
          tone: 'destructive',
        }
      : {
          title: `Request to disable ${user.email}?`,
          description:
            'Staff changes need a second administrator. Once another administrator approves, they’re signed out on every device immediately and can’t sign in.',
          confirmLabel: 'Send for approval',
          tone: 'destructive',
        };
  }
  return customer
    ? {
        title: `Enable sign-in for ${user.email}?`,
        description:
          'They can sign in again with their existing password. If you disabled this account yourself, a different administrator has to enable it.',
        confirmLabel: 'Enable sign-in',
        tone: 'primary',
      }
    : {
        title: `Request to re-enable ${user.email}?`,
        description: 'Staff changes need a second administrator. Once approved, they can sign in again with their existing password and authenticator.',
        confirmLabel: 'Send for approval',
        tone: 'primary',
      };
}

/** Confirms and performs a row action, explaining four-eyes outcomes and dual-control refusals */
export function UserActionDialog({
  action,
  open,
  onOpenChange,
}: {
  action: UserAction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  if (!action) return null;
  const { kind, user } = action;
  const copy = actionCopy(action);

  const perform = async () => {
    try {
      const result = kind === 'status' ? await api.admin.setUserActive(user.id, !user.isActive) : await api.admin.resetMfa(user.id);
      if (result.queued) {
        notifySuccess('Sent for approval by a second administrator', 'Track it under Approvals. Nothing changes until it’s approved.');
        void queryClient.invalidateQueries({ queryKey: qk.adminRequestsAll });
        return;
      }
      if (kind === 'status') {
        notifySuccess(
          user.isActive ? 'Sign-in disabled' : 'Sign-in enabled',
          user.isActive ? `${user.email} has been signed out on every device.` : `${user.email} can sign in again.`
        );
      } else {
        notifySuccess('Authenticator reset', `${user.email} must set up a new authenticator.`);
      }
      void queryClient.invalidateQueries({ queryKey: qk.directoryAll });
    } catch (error) {
      if (isApiError(error)) {
        if (error.code === 'FORBIDDEN' && kind === 'status' && !user.isActive && user.role === 'CUSTOMER') {
          // Dual control: whoever disabled a customer can't be the one to re-enable them
          toast.error('Another administrator must re-enable this user', {
            description: `You disabled ${user.email}, so a different administrator has to turn sign-in back on.`,
          });
          return;
        }
        if (error.code === 'APPROVAL_REQUIRED') {
          notifyError(error);
          void queryClient.invalidateQueries({ queryKey: qk.adminRequestsAll });
          return;
        }
        if (error.code === 'NOT_FOUND') {
          toast.error('User not found', { description: 'They may have been removed. The list has been refreshed.' });
          void queryClient.invalidateQueries({ queryKey: qk.directoryAll });
          return;
        }
        if (error.code === 'FORBIDDEN') {
          notifyError(error);
          return;
        }
      }
      // Possibly transient: keep the dialog open so the person can retry
      notifyError(error);
      throw error;
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      onConfirm={perform}
    />
  );
}
