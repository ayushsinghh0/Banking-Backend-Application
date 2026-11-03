import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import type { CashOperation } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { newIdempotencyKey, notifySuccess } from '@/lib/notify';
import { qk } from '@/lib/query';
import { maskAccountNumber } from '@/lib/validation';
import { useStepUp } from '@/features/security/StepUp';
import { Callout, Mono } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { CASH_TYPE_LABEL, formatDateTime, shortId } from './cash';

/** The customer account behind a cash operation: one bounded, cached read per account on the visible page */
export function useCashAccount(accountId: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.account(accountId),
    queryFn: () => api.accounts.get(accountId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function AccountCell({ accountId }: { accountId: string }) {
  const account = useCashAccount(accountId);
  if (account.data) return <span className="whitespace-nowrap tnum">{maskAccountNumber(account.data.accountNumber)}</span>;
  return <Mono value={accountId} />;
}

export type Decision = { kind: 'approve' | 'reject'; operation: CashOperation };

interface Problem {
  title: string;
  body: string;
  reference?: string;
}

function approveProblem(error: unknown): Problem {
  const code = isApiError(error) ? error.code : '';
  switch (code) {
    case 'FORBIDDEN':
      return {
        title: 'You can’t approve this request',
        body: 'You can’t approve a request you made, or one on your own account. Ask another administrator.',
      };
    case 'NO_TELLER_SESSION':
      return {
        title: 'The teller’s cash session isn’t open',
        body: 'The cash is handled in the requesting teller’s drawer, so their session must be open. Ask them to open it, or reject this request.',
      };
    case 'STALE_TELLER_SESSION':
      return {
        title: 'The teller’s session is from a previous day',
        body: 'They must close it before this can be approved. Otherwise, reject this request.',
      };
    case 'INSUFFICIENT_FUNDS':
      return {
        title: 'Not enough balance',
        body: 'The account no longer has enough money for this withdrawal. Reject it, and tell the teller not to pay out.',
      };
    case 'DAILY_LIMIT_EXCEEDED':
      return {
        title: 'Daily limit reached',
        body: 'This withdrawal would take the account past today’s limit. Reject it, and tell the teller not to pay out.',
      };
    case 'ACCOUNT_INACTIVE':
      return { title: 'Account frozen or closed', body: 'No cash can move on this account. Reject this request.' };
    case 'CONFLICT':
    case 'NOT_FOUND': {
      // Expired, or already decided by someone else: the server says which
      const { description } = describeError(error);
      return { title: 'This request can’t be approved', body: description };
    }
    default: {
      const { title, description, reference } = describeError(error);
      return { title, body: description, reference };
    }
  }
}

function rejectProblem(error: unknown): Problem {
  const { title, description, reference } = describeError(error);
  if (isApiError(error) && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) {
    return { title: 'This request was already decided', body: description };
  }
  return { title, body: description, reference };
}

/** Terminal answers: the list is out of date, so refresh it behind the dialog */
const isStale = (error: unknown) => isApiError(error) && ['CONFLICT', 'NOT_FOUND', 'ACCOUNT_INACTIVE'].includes(error.code);

/**
 * Approve or reject one pending cash operation behind an explicit confirmation. Approval moves money, so it
 * carries an idempotency key per operation, reused for every retry of that same approval.
 */
export function CashDecisionDialog({
  decision,
  requesterLabel,
  onClose,
}: {
  decision: Decision | null;
  requesterLabel: (id: string) => string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { run } = useStepUp();
  const [problem, setProblem] = useState<Problem | null>(null);
  const approvalKeys = useRef(new Map<string, string>());
  const op = decision?.operation;
  const account = useQuery({
    queryKey: qk.account(op?.accountId ?? ''),
    queryFn: () => api.accounts.get(op?.accountId ?? ''),
    enabled: false,
  });

  const noun = op ? CASH_TYPE_LABEL[op.type].toLowerCase() : '';
  const title = op ? CASH_TYPE_LABEL[op.type] : '';
  const accountText = account.data ? maskAccountNumber(account.data.accountNumber) : op ? `account ${shortId(op.accountId)}` : '';

  const confirm = async () => {
    if (!decision || !op) return;
    setProblem(null);
    if (decision.kind === 'approve') {
      let key = approvalKeys.current.get(op.id);
      if (!key) {
        key = newIdempotencyKey();
        approvalKeys.current.set(op.id, key);
      }
      try {
        const result = await run(() => api.supervisor.approveCash(op.id, key));
        approvalKeys.current.delete(op.id);
        notifySuccess(`${title} approved`, result.status === 'EXECUTED' ? `Reference ${result.transaction.referenceId}` : undefined);
      } catch (error) {
        setProblem(approveProblem(error));
        if (isStale(error)) void queryClient.invalidateQueries({ queryKey: qk.cashOperationsAll });
        throw error;
      }
    } else {
      try {
        await api.supervisor.rejectCash(op.id);
        notifySuccess(`${title} rejected`, 'The teller can see the decision in their operations.');
      } catch (error) {
        setProblem(rejectProblem(error));
        if (isStale(error)) void queryClient.invalidateQueries({ queryKey: qk.cashOperationsAll });
        throw error;
      }
    }
    await queryClient.invalidateQueries({ queryKey: qk.cashOperationsAll });
  };

  const description = !op
    ? undefined
    : decision?.kind === 'approve'
      ? `${formatPaise(op.amountInPaise)} cash ${noun} ${op.type === 'DEPOSIT' ? 'to' : 'from'} ${accountText}, requested by ${requesterLabel(op.requestedBy)} at ${formatDateTime(op.createdAt)}. The money moves as soon as you approve, and this can’t be undone.`
      : op.type === 'WITHDRAWAL'
        ? `${formatPaise(op.amountInPaise)} cash withdrawal from ${accountText}. The teller will see it as rejected and must not pay out. The customer will need a new withdrawal code to try again.`
        : `${formatPaise(op.amountInPaise)} cash deposit to ${accountText}. The teller will see it as rejected and must hand the customer’s cash back.`;

  return (
    <ConfirmDialog
      open={decision !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      title={decision?.kind === 'approve' ? `Approve this ${noun}?` : `Reject this ${noun}?`}
      description={description}
      confirmLabel={decision?.kind === 'approve' ? `Approve ${noun}` : `Reject ${noun}`}
      cancelLabel="Not now"
      tone={decision?.kind === 'reject' ? 'destructive' : 'primary'}
      onConfirm={confirm}
    >
      {problem ? (
        <Callout tone="danger" title={problem.title}>
          <p>{problem.body}</p>
          {problem.reference ? <p className="font-mono text-[11.5px]">Reference: {problem.reference}</p> : null}
        </Callout>
      ) : null}
      {op?.description ? (
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-[14px] leading-5">
          <p className="text-[12.5px] font-medium text-muted-foreground">Teller’s note</p>
          <p className="mt-0.5">{op.description}</p>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
