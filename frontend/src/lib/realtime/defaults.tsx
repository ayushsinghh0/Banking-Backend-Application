import { useLocation } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BankAccount } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/AuthProvider';
import { formatPaise } from '@/lib/money';
import { qk } from '@/lib/query';
import { maskAccountNumber } from '@/lib/validation';
import { useRealtimeEvent } from './RealtimeProvider';
import { isMoneyIn, type AccountStatusEvent, type PaymentUpdatedEvent, type TransactionPostedEvent } from './events';

const TYPE_NAME: Record<BankAccount['accountType'], string> = { SAVINGS: 'Savings', CURRENT: 'Current' };

/** "Savings ••••6789" from the accounts already in the cache, or a neutral fallback */
function accountName(queryClient: QueryClient, accountId: string): string {
  const account = queryClient.getQueryData<BankAccount[]>(qk.accounts)?.find((a) => a.id === accountId);
  return account ? `${TYPE_NAME[account.accountType]} ${maskAccountNumber(account.accountNumber)}` : 'your account';
}

/**
 * The reactions every signed-in page shares: refetch what an event changed and, for customers, a short
 * notification when money arrives or a top-up settles. Pages that already show the outcome (the transfer
 * receipt, the Add money flow) are left to say it themselves.
 */
export function RealtimeDefaults() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const customer = user?.role === 'CUSTOMER';
  const invalidate = (queryKey: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey });

  useRealtimeEvent<TransactionPostedEvent>('transaction.posted', (event) => {
    invalidate(qk.balances);
    invalidate(qk.historyAll);
    // A top-up has its own notification (payment.updated); money sent from the transfer page is on its receipt
    if (!customer || !isMoneyIn(event.direction) || event.type === 'ONLINE_TOP_UP' || pathname === '/transfer') return;
    toast.success(`${formatPaise(event.amountInPaise)} received`, {
      id: `rt-tx-${event.transactionId}`,
      description: `In ${accountName(queryClient, event.accountId)}`,
    });
  });

  useRealtimeEvent<PaymentUpdatedEvent>('payment.updated', (event) => {
    invalidate(qk.payments);
    if (event.status === 'CREDITED' || event.status === 'REFUNDED') {
      invalidate(qk.balances);
      invalidate(qk.historyAll);
    }
    if (!customer || pathname === '/add-money') return;
    const amount = formatPaise(event.amountInPaise);
    if (event.status === 'CREDITED') {
      toast.success(`${amount} added`, { id: `rt-topup-${event.topUpId}`, description: `To ${accountName(queryClient, event.accountId)}` });
    } else if (event.status === 'FAILED') {
      toast.error(`Payment of ${amount} failed`, { id: `rt-topup-${event.topUpId}`, description: 'Nothing was added to your account.' });
    }
  });

  useRealtimeEvent<AccountStatusEvent>('account.status', () => invalidate(qk.accounts));
  useRealtimeEvent('payee.added', () => invalidate(qk.beneficiaries));
  useRealtimeEvent('fraud.alert', () => invalidate(qk.alertsAll));

  return null;
}
