import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { isApiError } from '@/lib/api/errors';
import type { FraudAlert } from '@/lib/api/types';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/overlays';
import { alertKey, applyAlertUpdate } from './alertLookup';
import { CloseAlertDialog, isSevere, type CloseStatus } from './CloseAlertDialog';
import { ALERT_STATUS_LABEL, shortId } from './format';
import { hasCode, isRefusal } from './hooks';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';
import { Panel } from './layout';

type SimpleIntent = 'start' | 'reopen' | 'withdraw' | 'decline';
type Intent = { kind: SimpleIntent } | { kind: 'close'; status: CloseStatus; confirming: boolean };

const SIMPLE_DONE: Record<SimpleIntent, string> = {
  start: 'Review started',
  reopen: 'Alert reopened',
  withdraw: 'Proposal withdrawn',
  decline: 'Proposal rejected',
};

const CONFIRMS: Record<Exclude<SimpleIntent, 'start'>, { title: string; description: string; confirmLabel: string }> = {
  reopen: {
    title: 'Reopen this alert for review?',
    description: 'It goes back to Under review so analysts can look at it again. The earlier decision stays in the history.',
    confirmLabel: 'Reopen for review',
  },
  withdraw: {
    title: 'Withdraw your proposal?',
    description: 'The alert stays under review and nobody can confirm the proposal any more. You or another analyst can propose again.',
    confirmLabel: 'Withdraw proposal',
  },
  decline: {
    title: 'Reject this proposal?',
    description: 'The alert stays under review and the proposal is cleared. Either analyst can then propose a different outcome.',
    confirmLabel: 'Reject proposal',
  },
};

const closingVerb = (status: CloseStatus) => (status === 'RESOLVED' ? 'resolving' : 'dismissing');
const closingNoun = (status: CloseStatus) => (status === 'RESOLVED' ? 'resolution' : 'dismissal');

function refusal(error: unknown, alert: FraudAlert, me: string): Outcome {
  if (hasCode(error, 'CONFLICT') || (hasCode(error, 'FORBIDDEN') && alert.closeRequestedBy === me)) {
    return {
      tone: 'danger',
      title: 'A different analyst must confirm this',
      body: 'Closing a high or critical alert needs two analysts. Your proposal is waiting for a colleague to confirm it.',
    };
  }
  if (hasCode(error, 'FORBIDDEN') && alert.initiatedBy === me) {
    return { tone: 'danger', title: 'You can’t triage this alert', body: 'It’s about a transaction you initiated, so another analyst must handle it.' };
  }
  if (hasCode(error, 'FORBIDDEN')) {
    return {
      tone: 'danger',
      title: 'You can’t make this change',
      body: 'Only fraud analysts can triage alerts, and never for a transaction they initiated or to confirm their own proposal.',
    };
  }
  if (hasCode(error, 'NOT_FOUND')) {
    return { tone: 'danger', title: 'This alert no longer exists', body: 'Go back to the alert list to see current alerts.' };
  }
  return outcomeFromError(error);
}

/**
 * Fraud analyst actions, following the service rules: nobody triages an alert about a transaction they
 * initiated; closing a HIGH/CRITICAL alert is a proposal that a different analyst confirms (same target
 * status); any non-closing change clears a pending proposal. The message shown always reflects what the
 * API actually did, which can differ from the intent if someone else acted in the meantime.
 */
export function TriagePanel({ alert, me, className }: { alert: FraudAlert; me: string; className?: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState<{ status: CloseStatus; confirming: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Exclude<SimpleIntent, 'start'> | null>(null);
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const severe = isSevere(alert);
  const closed = alert.status === 'RESOLVED' || alert.status === 'DISMISSED';
  const proposal =
    alert.closeRequestedBy && alert.closeRequestedStatus && !closed
      ? { by: alert.closeRequestedBy, status: alert.closeRequestedStatus as CloseStatus }
      : null;

  /** Resolves when the API answered (done or refused, shown in the panel); rejects on transient failures */
  const submit = async (intent: Intent, note?: string): Promise<void> => {
    setOutcome(null);
    const status = intent.kind === 'close' ? intent.status : 'UNDER_REVIEW';
    try {
      const { pendingSecondApproval: _ignored, ...updated } = (await api.fraud.updateAlert(alert.id, status, note)) as FraudAlert & {
        pendingSecondApproval?: boolean;
      };
      applyAlertUpdate(queryClient, updated);
      const closedNow = updated.status === 'RESOLVED' || updated.status === 'DISMISSED';
      if (closedNow) {
        notifySuccess(updated.status === 'RESOLVED' ? 'Alert resolved' : 'Alert dismissed');
        if (intent.kind === 'close' && !intent.confirming && severe) {
          setOutcome({ tone: 'info', title: 'Another analyst had already proposed this, so your decision confirmed it and the alert is now closed.' });
        }
      } else if (updated.closeRequestedBy === me) {
        notifySuccess('Proposal recorded', 'A second analyst must confirm before the alert closes.');
        if (intent.kind === 'close' && intent.confirming) {
          setOutcome({ tone: 'info', title: 'The earlier proposal had been withdrawn', body: 'Your decision is now a new proposal, waiting for a second analyst.' });
        }
      } else {
        notifySuccess(intent.kind === 'close' ? 'Alert updated' : SIMPLE_DONE[intent.kind]);
      }
    } catch (error) {
      if (isApiError(error) && error.fieldErrors.note) throw error;
      if (!isRefusal(error)) throw error;
      setOutcome(refusal(error, alert, me));
      void queryClient.invalidateQueries({ queryKey: alertKey(alert.id) });
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await submit({ kind: 'start' });
    } catch (error) {
      notifyError(error);
    } finally {
      setStarting(false);
    }
  };

  const lead = (text: ReactNode) => <p className="text-[14px] leading-5 text-muted-foreground">{text}</p>;
  let body: ReactNode;
  if (alert.initiatedBy === me) {
    body = (
      <div className="space-y-1">
        <p className="text-[15px] font-medium tracking-[-0.01em]">You can’t triage this alert</p>
        {lead('It’s about a transaction you initiated, so another analyst must handle it.')}
      </div>
    );
  } else if (closed) {
    body = (
      <>
        {lead(`This alert is ${ALERT_STATUS_LABEL[alert.status].toLowerCase()}. Reopen it if new information comes to light.`)}
        <Button variant="secondary" block className="h-11" onClick={() => setConfirm('reopen')}>
          Reopen for review
        </Button>
      </>
    );
  } else if (proposal && proposal.by === me) {
    body = (
      <>
        {lead(`You proposed ${closingVerb(proposal.status)} this alert. Another analyst must confirm it before the alert closes.`)}
        <Button variant="secondary" block className="h-11" onClick={() => setConfirm('withdraw')}>
          Withdraw proposal
        </Button>
      </>
    );
  } else if (proposal) {
    body = (
      <>
        {lead(
          <>
            Analyst <span title={proposal.by}>{shortId(proposal.by)}</span> proposed {ALERT_STATUS_LABEL[proposal.status]}. Check the evidence,
            then confirm or reject the proposal.
          </>
        )}
        <div className="grid gap-2">
          <Button block className="h-11" onClick={() => setClosing({ status: proposal.status, confirming: true })}>
            {`Confirm ${closingNoun(proposal.status)}`}
          </Button>
          <Button variant="secondary" block className="h-11" onClick={() => setConfirm('decline')}>
            Reject proposal
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="grid gap-2">
          {alert.status === 'OPEN' ? (
            <Button block className="h-11" loading={starting} onClick={() => void start()}>
              Start review
            </Button>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" className="h-11" onClick={() => setClosing({ status: 'RESOLVED', confirming: false })}>
              Resolve
            </Button>
            <Button variant="secondary" className="h-11" onClick={() => setClosing({ status: 'DISMISSED', confirming: false })}>
              Dismiss
            </Button>
          </div>
        </div>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          {severe
            ? 'High and critical alerts need two analysts: closing records your proposal, and a different analyst confirms it.'
            : 'Low and medium alerts close as soon as you decide. Closing always needs a note.'}
        </p>
      </>
    );
  }

  const confirmCopy = confirm ? CONFIRMS[confirm] : null;

  return (
    <Panel title="Triage" className={className} bodyClassName="space-y-4">
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      {body}
      <CloseAlertDialog
        alert={alert}
        intent={closing}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
        onSubmitNote={(note) => submit({ kind: 'close', status: closing!.status, confirming: closing!.confirming }, note)}
      />
      {confirm && confirmCopy ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={confirmCopy.title}
          description={confirmCopy.description}
          confirmLabel={confirmCopy.confirmLabel}
          tone={confirm === 'reopen' ? 'primary' : 'destructive'}
          onConfirm={async () => {
            try {
              await submit({ kind: confirm });
            } catch (error) {
              notifyError(error);
              throw error;
            }
          }}
        />
      ) : null}
    </Panel>
  );
}
