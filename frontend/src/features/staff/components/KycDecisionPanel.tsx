import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { notifyError, notifySuccess } from '@/lib/notify';
import type { CustomerProfile } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { formatDateTime } from './format';
import { hasCode, isRefusal } from './hooks';
import { OutcomeCallout, outcomeFromError, type Outcome } from './Outcome';
import { Panel } from './layout';

type Decision = { status: 'VERIFIED' | 'REJECTED'; version: number };

const GUIDANCE = {
  PENDING: 'Check the name, date of birth and address against the customer’s documents, then decide.',
  VERIFIED: 'This customer is verified. If new evidence shows these details are wrong, you can reject them.',
  REJECTED: 'This customer was rejected. If they have since provided valid documents, you can verify them.',
} as const;

/**
 * KYC officers decide on the exact profile version on screen (compare-and-set): if the customer edits
 * anything first, the API refuses with PROFILE_CHANGED and the officer reviews the new details.
 */
export function KycDecisionPanel({ profile, me, className }: { profile: CustomerProfile; me: string; className?: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { userId, fullName } = profile;

  const decide = async () => {
    if (!decision) return;
    setOutcome(null);
    try {
      const updated = await api.customers.decideKyc(userId, decision.status, decision.version);
      queryClient.setQueryData(qk.customer(userId), updated);
      void queryClient.invalidateQueries({ queryKey: qk.kycHistory(userId) });
      void queryClient.invalidateQueries({ queryKey: qk.customersAll });
      if (decision.status === 'VERIFIED') notifySuccess('KYC verified', `${fullName} can now open accounts.`);
      else notifySuccess('KYC rejected', `${fullName} can’t open new accounts until they pass review.`);
    } catch (error) {
      if (hasCode(error, 'PROFILE_CHANGED')) {
        setOutcome({
          tone: 'warning',
          title: 'The customer changed their details since you opened this page — review the latest version',
          body: 'Nothing was decided. The profile now shows their latest details.',
        });
        void queryClient.invalidateQueries({ queryKey: qk.customer(userId) });
        void queryClient.invalidateQueries({ queryKey: qk.kycHistory(userId) });
        return;
      }
      if (hasCode(error, 'FORBIDDEN')) {
        setOutcome({
          tone: 'danger',
          title: 'You can’t decide this customer’s KYC',
          body: 'Staff can’t decide their own KYC, and only KYC officers can make decisions.',
        });
        return;
      }
      if (isRefusal(error)) {
        setOutcome(outcomeFromError(error));
        void queryClient.invalidateQueries({ queryKey: qk.customer(userId) });
        return;
      }
      // Transient: keep the dialog open so the officer can try again
      notifyError(error);
      throw error;
    }
  };

  const verifying = decision?.status === 'VERIFIED';

  return (
    <Panel title="KYC decision" className={className} bodyClassName="space-y-4">
      <OutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
      {profile.userId === me ? (
        <Callout tone="info" title="This is your own profile">
          Another KYC officer must review it.
        </Callout>
      ) : (
        <>
          <p className="text-pretty text-[14px] leading-5 text-muted-foreground">{GUIDANCE[profile.kycStatus]}</p>
          <div className="grid gap-2">
            {profile.kycStatus !== 'VERIFIED' ? (
              <Button block className="h-11" onClick={() => setDecision({ status: 'VERIFIED', version: profile.version })}>
                Verify identity
              </Button>
            ) : null}
            {profile.kycStatus !== 'REJECTED' ? (
              <Button
                variant="secondary"
                block
                className="h-11 text-destructive"
                onClick={() => setDecision({ status: 'REJECTED', version: profile.version })}
              >
                Reject KYC
              </Button>
            ) : null}
          </div>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            Your decision applies to version {profile.version} of the profile. If the customer edits it first, nothing is decided.
          </p>
        </>
      )}
      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title={verifying ? `Verify ${fullName}’s identity?` : `Reject ${fullName}’s KYC?`}
        description={
          verifying
            ? 'They’ll be able to open accounts.'
            : 'They won’t be able to open new accounts until they update their details and pass review. Existing accounts aren’t affected.'
        }
        confirmLabel={verifying ? 'Verify identity' : 'Reject KYC'}
        tone={verifying ? 'primary' : 'destructive'}
        onConfirm={decide}
      >
        <p className="text-pretty text-[13px] leading-[18px] text-muted-foreground">
          You’re deciding on version {decision?.version ?? profile.version} of this profile, last changed {formatDateTime(profile.updatedAt)}.
          If the customer changes anything first, nothing is decided and you’ll see their new details.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
