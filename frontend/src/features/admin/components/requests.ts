import { isApiError } from '@/lib/api/errors';
import type { AdminRequest } from '@/lib/api/types';
import { isPast } from './format';
import { roleLabel } from './roles';
import { personText, type ResolvePerson } from './useUserLookup';

/** "Create staff member", "Disable sign-in", ... */
export function requestTitle(request: AdminRequest): string {
  switch (request.type) {
    case 'CREATE_STAFF':
      return 'Create staff member';
    case 'SET_USER_ACTIVE':
      return request.payload.isActive ? 'Enable sign-in' : 'Disable sign-in';
    case 'RESET_MFA':
      return 'Reset authenticator';
  }
}

export const requestTargetId = (request: AdminRequest): string | null => request.targetUserId ?? request.payload.userId ?? null;

/** Still PENDING in the database, but past its deadline: it can no longer be approved */
export const isExpired = (request: AdminRequest, now: number = Date.now()) =>
  request.status === 'PENDING' && isPast(request.expiresAt, now);

/** Who or what the request is about, as plain text for dialogs and toasts */
export function subjectText(request: AdminRequest, resolve: ResolvePerson): string {
  if (request.type === 'CREATE_STAFF') return request.payload.email ?? 'the new staff member';
  return personText(resolve(requestTargetId(request)), 'this user');
}

export interface DecisionCopy {
  title: string;
  description: string;
  confirmLabel: string;
  tone: 'primary' | 'destructive';
}

/** Exactly what approving will do, in the words the confirmation dialog uses */
export function approvalCopy(request: AdminRequest, resolve: ResolvePerson): DecisionCopy {
  const subject = subjectText(request, resolve);
  switch (request.type) {
    case 'CREATE_STAFF': {
      const role = request.payload.role ? roleLabel(request.payload.role) : 'staff';
      return {
        title: 'Approve new staff member?',
        description: `This creates a ${role} account and emails a one-time activation link to ${subject}. They choose their own password and set up their authenticator — administrators never see staff passwords.`,
        confirmLabel: 'Approve and send invite',
        tone: 'primary',
      };
    }
    case 'SET_USER_ACTIVE':
      return request.payload.isActive
        ? {
            title: `Approve re-enabling ${subject}?`,
            description: 'They can sign in again with their existing password and authenticator.',
            confirmLabel: 'Approve and enable',
            tone: 'primary',
          }
        : {
            title: `Approve disabling ${subject}?`,
            description: 'They’re signed out on every device immediately and can’t sign in until their sign-in is enabled again.',
            confirmLabel: 'Approve and disable',
            tone: 'destructive',
          };
    case 'RESET_MFA': {
      const target = resolve(requestTargetId(request));
      const role = target?.kind === 'user' ? target.user.role : undefined;
      const next =
        role === 'CUSTOMER'
          ? 'They can sign in with their password and set up two-factor authentication again in their security settings.'
          : role
            ? 'They’ll receive a one-time email link to enrol a new authenticator before they can work again.'
            : 'Staff receive a one-time email link to enrol a new authenticator; customers can set up two-factor authentication again in their security settings.';
      return {
        title: `Approve authenticator reset for ${subject}?`,
        description: `Their current authenticator stops working and they’re signed out everywhere. ${next}`,
        confirmLabel: 'Approve reset',
        tone: 'destructive',
      };
    }
  }
}

export function rejectionCopy(request: AdminRequest, resolve: ResolvePerson, mine: boolean): DecisionCopy {
  const subject = subjectText(request, resolve);
  return mine
    ? {
        title: 'Withdraw your request?',
        description: `It leaves the approval queue and nothing changes for ${subject}.`,
        confirmLabel: 'Withdraw request',
        tone: 'destructive',
      }
    : {
        title: 'Reject this request?',
        description: `Nothing changes for ${subject}. The requester can submit a new request if the change is still needed.`,
        confirmLabel: 'Reject request',
        tone: 'destructive',
      };
}

export function approvedMessage(request: AdminRequest, resolve: ResolvePerson): { title: string; description: string } {
  const subject = subjectText(request, resolve);
  switch (request.type) {
    case 'CREATE_STAFF':
      return {
        title: 'Staff member approved',
        description: `${subject} will receive an activation email to set their own password and authenticator.`,
      };
    case 'SET_USER_ACTIVE':
      return request.payload.isActive
        ? { title: 'Sign-in enabled', description: `${subject} can sign in again.` }
        : { title: 'Sign-in disabled', description: `${subject} has been signed out on every device.` };
    case 'RESET_MFA':
      return { title: 'Authenticator reset', description: `${subject} must set up a new authenticator before signing in again.` };
  }
}

/**
 * Decision failures that retrying can't fix (the request changed, or this administrator may not decide it).
 * Returns null for anything else, e.g. a transient failure the person can retry from the open dialog.
 */
export function decisionProblem(error: unknown, kind: 'approve' | 'reject'): { title: string; description: string } | null {
  if (!isApiError(error)) return null;
  switch (error.code) {
    case 'CONFLICT':
      // The service answers 409 both for "already decided" and "expired" (it closes expired requests itself)
      return /expired/i.test(error.message)
        ? { title: 'This request has expired', description: 'It was closed without any change. Ask for a new request if the change is still needed.' }
        : { title: 'Already decided', description: 'Another administrator decided this request a moment ago. The list has been refreshed.' };
    case 'NOT_FOUND':
      return { title: 'Request not found', description: 'It may have been removed. The list has been refreshed.' };
    case 'FORBIDDEN':
      return kind === 'approve'
        ? {
            title: 'You can’t approve this request',
            description: 'Requests must be approved by an administrator who didn’t make them and isn’t affected by them.',
          }
        : {
            title: 'You can’t reject this request',
            description: 'Requests about your own account must be decided by another administrator.',
          };
    default:
      return null;
  }
}
