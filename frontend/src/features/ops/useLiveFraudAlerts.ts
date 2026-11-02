import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { humanize } from '@/components/ui/primitives';
import { qk } from '@/lib/query';
import { useRealtimeEvent, type FraudAlertRaisedEvent } from '@/lib/realtime';

const TOAST_ID = 'ops-new-fraud-alert';

/**
 * Keeps fraud queues current: every `fraud.alert` event refreshes the alert lists (and the overview's count).
 * With `notify`, a quiet toast says so; alerts arriving while it shows are counted into the same toast
 * rather than stacking.
 */
export function useLiveFraudAlerts({ notify }: { notify: boolean }): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const unseen = useRef(0);

  const onAlert = useCallback(
    (event: FraudAlertRaisedEvent) => {
      void queryClient.invalidateQueries({ queryKey: qk.alertsAll });
      if (!notify) return;
      unseen.current += 1;
      const count = unseen.current;
      const reset = () => {
        unseen.current = 0;
      };
      const single = count === 1 && typeof event?.alertId === 'string' && event.alertId;
      toast(count === 1 ? 'New alert' : `${count} new alerts`, {
        id: TOAST_ID,
        description: count === 1 && event?.severity ? `${humanize(String(event.severity))} severity` : 'The queue has been updated.',
        action: single
          ? { label: 'View', onClick: () => navigate(`/fraud/${encodeURIComponent(event.alertId)}`) }
          : { label: 'View queue', onClick: () => navigate('/fraud') },
        onDismiss: reset,
        onAutoClose: reset,
      });
    },
    [queryClient, navigate, notify]
  );

  useRealtimeEvent<FraudAlertRaisedEvent>('fraud.alert', onAlert);
}
