import { counter, histogram } from '@banksphere/common';

/** One increment per committed status change, labelled with the status entered */
export const topUpTransitions = counter('payments_topups_total', 'Top-up status transitions by the status entered', ['status']);

/** Webhook deliveries by Razorpay event (known events only, everything else is "other") and outcome */
export const webhookDeliveries = counter('payments_webhooks_total', 'Razorpay webhook deliveries by event and result', [
  'event',
  'result',
]);

export const razorpayRequestSeconds = histogram(
  'payments_razorpay_request_seconds',
  'Razorpay API call duration by operation and outcome',
  ['operation', 'outcome'],
  [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30]
);

export const reconcilerRuns = counter('payments_reconciler_runs_total', 'Reconciler runs by result', ['result']);
export const reconcilerActions = counter('payments_reconciler_actions_total', 'Changes made by the reconciler', ['action']);
