import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { DescriptionList } from '@/components/ui/primitives';
import { opsKeys, useOpsApi, type ReconcileReport } from '../api';
import { reportEntries } from '../format';
import { notifyOpsError } from '../notify';

/**
 * Runs the reconciler now (it also runs every minute) and shows what it found: orders still waiting on
 * Razorpay, captures not yet credited, refunds in flight.
 */
export function ReconcileButton() {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const mutation = useMutation({
    mutationFn: () => ops.payments.reconcile(),
    onSuccess: (result) => {
      setReport(result);
      void queryClient.invalidateQueries({ queryKey: opsKeys.payments });
    },
    onError: notifyOpsError,
  });
  const entries = report ? reportEntries(report) : [];

  return (
    <>
      <Button variant="secondary" loading={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? null : <RefreshCw aria-hidden="true" />}
        Reconcile now
      </Button>
      <Dialog open={report !== null} onOpenChange={(open) => !open && setReport(null)}>
        <DialogContent size="sm">
          <DialogHeader
            title="Reconciliation finished"
            description="Open orders, captures not yet credited and refunds in flight were checked against Razorpay."
          />
          {entries.length ? (
            <DescriptionList items={entries.map((entry) => ({ label: entry.label, value: <span className="tnum">{entry.value}</span> }))} />
          ) : (
            <p className="text-[15px] text-muted-foreground">Nothing needed attention.</p>
          )}
          <DialogFooter>
            <Button onClick={() => setReport(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
