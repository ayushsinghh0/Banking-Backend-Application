import type { TopUpStatus } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { humanize } from '@/components/ui/primitives';

/** How a top-up looks from the customer's side */
export type TopUpOutcome = 'pending' | 'credited' | 'failed' | 'cancelled' | 'returned';

const OUTCOME: Record<TopUpStatus, TopUpOutcome> = {
  CREATED: 'pending',
  PENDING: 'pending',
  // Razorpay has the money; the ledger credit follows within seconds
  CAPTURED: 'pending',
  CREDITED: 'credited',
  FAILED: 'failed',
  EXPIRED: 'failed',
  CANCELLED: 'cancelled',
  // The money was taken but couldn't be credited (or was later refunded): it goes back to the customer
  CREDIT_BLOCKED: 'returned',
  REFUND_PENDING: 'returned',
  REFUNDED: 'returned',
};

export const topUpOutcome = (status: TopUpStatus): TopUpOutcome => OUTCOME[status] ?? 'pending';

export const TOP_UP_STATUS_LABEL: Record<TopUpStatus, string> = {
  CREATED: 'Waiting for payment',
  PENDING: 'Waiting for payment',
  CAPTURED: 'Processing',
  CREDITED: 'Added',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  CREDIT_BLOCKED: 'On hold',
  REFUND_PENDING: 'Refund in progress',
  REFUNDED: 'Refunded',
};

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay later' };

/** "upi" -> "UPI" */
export const methodLabel = (method: string | null | undefined): string | null =>
  method ? (METHOD_LABEL[method.toLowerCase()] ?? humanize(method)) : null;

export interface TopUpProblem {
  title: string;
  description: string;
  /** The form field the problem belongs to */
  field?: 'amount' | 'accountId';
}

/**
 * What to tell the customer when a top-up can't be started. The payment service's refusals are matched on
 * their codes; anything else uses the shared catalog.
 */
export function topUpProblem(error: unknown): TopUpProblem {
  if (isApiError(error)) {
    const code = error.code;
    if (code === 'KYC_NOT_VERIFIED') {
      return { title: 'Identity verification pending', description: 'You can add money once we’ve verified your identity.' };
    }
    if (code.includes('DAILY_LIMIT')) {
      return {
        title: 'Daily limit reached',
        description: 'This would go over today’s limit for adding money. Try a smaller amount, or try again tomorrow.',
        field: 'amount',
      };
    }
    if (code.includes('OPEN_TOP_UPS') || code.includes('OPEN_ORDERS') || code.includes('TOO_MANY_PENDING')) {
      return {
        title: 'Too many payments in progress',
        description: 'Finish or cancel the payments you’ve already started, or wait a few minutes, then try again.',
      };
    }
    if (code === 'ACCOUNT_NOT_CREDITABLE' || code === 'ACCOUNT_INACTIVE') {
      return { title: 'Account unavailable', description: 'This account can’t receive money right now. Choose another account.', field: 'accountId' };
    }
    if (code.startsWith('AMOUNT_') || code === 'INVALID_AMOUNT') {
      return { title: 'Check the amount', description: error.fieldErrors.amountPaise ?? 'This amount can’t be added. Try a different amount.', field: 'amount' };
    }
  }
  const { title, description } = describeError(error);
  return { title, description };
}
