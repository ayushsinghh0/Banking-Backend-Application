import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Loader2, RotateCcw, ShieldCheck, Undo2, Wallet, X } from 'lucide-react';
import type { BankAccount, CheckoutDetails, KycStatus, PaymentConfig, PaymentProof, SimulatedMethod, SimulatedOutcome, TopUp } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { comparePaise, formatPaise, parseRupees } from '@/lib/money';
import { newIdempotencyKey } from '@/lib/notify';
import { useRealtimeEvent, useRealtimeStatus, type PaymentUpdatedEvent } from '@/lib/realtime';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Field } from '@/components/ui/input';
import { BigAmount, Callout, Card, CopyButton, EmptyState, Skeleton, humanize } from '@/components/ui/primitives';
import { useAccounts, useBalances, useNow, useProfile } from './hooks';
import { accountShortName, formatDate, formatTime } from './lib';
import { loadRazorpayCheckout, type RazorpayConstructor } from './razorpay';
import { methodLabel, topUpOutcome, topUpProblem, type TopUpProblem } from './topups';
import { AccountSwatch } from './components/AccountCard';
import { AmountField } from './components/AmountField';
import { RecentTopUps } from './components/RecentTopUps';
import { Select } from './components/Select';
import { TestCheckoutSheet } from './components/TestCheckoutSheet';
import { TileFooter } from './components/TileFooter';

/** Quick amounts, in paise: ₹500, ₹1,000, ₹5,000, ₹10,000 */
const QUICK_AMOUNTS = ['50000', '100000', '500000', '1000000'];
/** Checkout's accent colour: the app's ink */
const CHECKOUT_COLOUR = '#1D1D1F';
/** How often to ask for the outcome while waiting: often without real-time updates, rarely as a safety net with them */
const POLL_MS = 2_000;
const POLL_WITH_REALTIME_MS = 5_000;
/** After this long, say that it is taking longer than usual */
const SLOW_AFTER_MS = 60_000;

const rupees = (paise: string) => formatPaise(paise).replace(/\.00$/, '');
const minPaise = (a: string, b: string) => (comparePaise(a, b) <= 0 ? a : b);

function buildSchema(limits: PaymentConfig['limits']) {
  return z
    .object({ accountId: z.string().min(1, 'Choose an account'), amount: z.string() })
    .superRefine((values, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['amount'], message });
      if (!values.amount.trim()) return issue('Enter an amount');
      const paise = parseRupees(values.amount);
      if (!paise) return issue('Enter an amount greater than ₹0.00');
      if (comparePaise(paise, limits.minPaise) < 0) return issue(`The smallest amount you can add is ${formatPaise(limits.minPaise)}`);
      if (comparePaise(paise, limits.maxPaise) > 0) return issue(`You can add up to ${formatPaise(limits.maxPaise)} in one payment`);
      if (comparePaise(paise, limits.remainingTodayPaise) > 0) return issue(`You can add up to ${formatPaise(limits.remainingTodayPaise)} more today`);
    })
    .transform((values) => ({ accountId: values.accountId, amountPaise: parseRupees(values.amount) ?? '0' }));
}

type Schema = ReturnType<typeof buildSchema>;

/**
 * One payment attempt. `checkout`: the customer is in Checkout (or the test sheet); `confirming`: the signed
 * result is on its way to the server; `tracking`: waiting for the ledger credit; `failed`: Checkout reported
 * a failed payment.
 */
interface Attempt {
  topUp: TopUp;
  checkout: CheckoutDetails;
  account: BankAccount;
  stage: 'checkout' | 'confirming' | 'tracking' | 'failed';
  failure?: string;
  since: number;
}

/** An attempt whose outcome is unknown is retried with the same idempotency key */
const isUnsettled = (error: unknown) => !isApiError(error) || error.isRetryable || error.status >= 500 || error.status === 0;

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="large-title">Add money</h1>
      {children}
    </div>
  );
}

export default function AddMoneyPage() {
  const { api } = useAuth();
  const [params] = useSearchParams();
  const accountsQuery = useAccounts();
  const profileQuery = useProfile();
  const configQuery = useQuery({ queryKey: qk.paymentsConfig, queryFn: () => api.payments.config() });

  if (accountsQuery.isError || configQuery.isError) {
    const failed = accountsQuery.isError ? accountsQuery : configQuery;
    return (
      <Shell>
        <Card>
          <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />
        </Card>
      </Shell>
    );
  }
  if (accountsQuery.isPending || configQuery.isPending) {
    return (
      <Shell>
        <Card className="space-y-6 p-5 sm:p-7" aria-busy="true">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-[76px] w-full rounded-2xl" />
          <Skeleton className="h-9 w-72 rounded-full" />
        </Card>
      </Shell>
    );
  }
  const active = accountsQuery.data.filter((a) => a.status === 'ACTIVE');
  if (active.length === 0) {
    return (
      <Shell>
        <Card>
          <EmptyState
            icon={Wallet}
            title="No account to add money to"
            description="You need an active account to add money. Open one, or contact the bank if your account is frozen."
            action={
              <Button asChild variant="secondary">
                <Link to="/accounts">Go to accounts</Link>
              </Button>
            }
          />
        </Card>
      </Shell>
    );
  }
  const kycStatus: KycStatus | null | undefined = profileQuery.isSuccess ? (profileQuery.data?.kycStatus ?? null) : undefined;
  return (
    <Shell>
      <AddMoneyFlow accounts={active} config={configQuery.data} kycStatus={kycStatus} initialAccountId={params.get('account')} />
      <RecentTopUps accounts={accountsQuery.data} />
    </Shell>
  );
}

function AddMoneyFlow({
  accounts,
  config,
  kycStatus,
  initialAccountId,
}: {
  accounts: BankAccount[];
  config: PaymentConfig;
  kycStatus: KycStatus | null | undefined;
  initialAccountId: string | null;
}) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const realtime = useRealtimeStatus();
  const { limits } = config;
  const schema = useMemo(() => buildSchema(limits), [limits]);
  const form = useForm<z.input<Schema>, unknown, z.output<Schema>>({
    resolver: zodResolver(schema),
    defaultValues: { accountId: accounts.find((a) => a.id === initialAccountId)?.id ?? accounts[0]?.id ?? '', amount: '' },
  });
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [problem, setProblem] = useState<TopUpProblem | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sheetBusy, setSheetBusy] = useState<'pay' | 'decline' | null>(null);
  const [sheetProblem, setSheetProblem] = useState<{ title: string; description: string } | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const inFlight = useRef(false);
  /** The last start whose outcome is unknown: the same top-up started again must reuse its key */
  const unsettled = useRef<{ key: string; fingerprint: string } | null>(null);

  const change = (next: Attempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  };
  const update = (topUpId: string, patch: Partial<Attempt>) => {
    const current = attemptRef.current;
    if (current?.topUp.id === topUpId) change({ ...current, ...patch });
  };

  const tracking = attempt?.stage === 'tracking';
  const tracked = useQuery({
    queryKey: qk.topUp(attempt?.topUp.id ?? ''),
    queryFn: () => api.payments.topUp(attempt?.topUp.id ?? ''),
    enabled: tracking,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && topUpOutcome(status) !== 'pending') return false;
      return realtime === 'open' ? POLL_WITH_REALTIME_MS : POLL_MS;
    },
  });
  const outcome = tracking && tracked.data ? topUpOutcome(tracked.data.status) : null;

  // A real-time update about this top-up: fetch its new state now rather than at the next poll
  useRealtimeEvent<PaymentUpdatedEvent>('payment.updated', (event) => {
    if (event.topUpId === attemptRef.current?.topUp.id) void queryClient.invalidateQueries({ queryKey: qk.topUp(event.topUpId) });
  });

  useEffect(() => {
    if (!outcome || outcome === 'pending') return;
    void queryClient.invalidateQueries({ queryKey: qk.payments });
    if (outcome === 'credited' || outcome === 'returned') {
      void queryClient.invalidateQueries({ queryKey: qk.balances });
      void queryClient.invalidateQueries({ queryKey: qk.historyAll });
    }
    if (outcome === 'cancelled') {
      change(null);
      setCancelled(true);
    }
    // Once per outcome of an attempt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, attempt?.topUp.id]);

  const confirm = async (current: Attempt, proof: PaymentProof) => {
    update(current.topUp.id, { stage: 'confirming', failure: undefined });
    try {
      const confirmed = await api.payments.confirmTopUp(current.topUp.id, proof);
      queryClient.setQueryData(qk.topUp(current.topUp.id), confirmed);
    } catch {
      // Unclear or refused: the payment's webhook and the reconciler settle it on the server, so keep watching
    }
    update(current.topUp.id, { stage: 'tracking', since: Date.now() });
  };

  const cancel = async (current: Attempt) => {
    if (attemptRef.current?.topUp.id === current.topUp.id) change(null);
    setCancelled(true);
    try {
      await api.payments.cancelTopUp(current.topUp.id);
    } catch {
      // An unpaid order expires on its own
    }
    void queryClient.invalidateQueries({ queryKey: qk.payments });
  };

  const openCheckout = async (current: Attempt) => {
    let Razorpay: RazorpayConstructor;
    try {
      Razorpay = await loadRazorpayCheckout();
    } catch {
      change(null);
      setProblem({ title: 'We couldn’t open the payment window', description: 'Check your connection and try again. You haven’t been charged.' });
      void api.payments.cancelTopUp(current.topUp.id).catch(() => undefined);
      return;
    }
    let paid = false;
    let failed = false;
    const { checkout } = current;
    const instance = new Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      theme: { color: CHECKOUT_COLOUR },
      handler: (response) => {
        paid = true;
        void confirm(current, {
          razorpayPaymentId: response.razorpay_payment_id,
          razorpayOrderId: response.razorpay_order_id,
          razorpaySignature: response.razorpay_signature,
        });
      },
      modal: {
        confirm_close: true,
        // Closed without paying: release the order. After a reported failure the order is already settled.
        ondismiss: () => {
          if (!paid && !failed) void cancel(current);
        },
      },
    });
    // Checkout stays open after a failure so the customer can try another method; success still wins later
    instance.on('payment.failed', (response) => {
      failed = true;
      update(current.topUp.id, { stage: 'failed', failure: response.error?.description });
    });
    instance.open();
  };

  const start = form.handleSubmit(async ({ accountId, amountPaise }) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account || inFlight.current) return;
    const fingerprint = `${account.id}:${amountPaise}`;
    const key = unsettled.current?.fingerprint === fingerprint ? unsettled.current.key : newIdempotencyKey();
    inFlight.current = true;
    setStarting(true);
    setProblem(null);
    setCancelled(false);
    try {
      const created = await api.payments.createTopUp({ accountId: account.id, amountPaise }, key);
      unsettled.current = null;
      const next: Attempt = { topUp: created.topUp, checkout: created.checkout, account, stage: 'checkout', since: Date.now() };
      change(next);
      setSheetProblem(null);
      void queryClient.invalidateQueries({ queryKey: qk.topUps });
      if (config.mode !== 'simulator') await openCheckout(next);
    } catch (error) {
      unsettled.current = isUnsettled(error) ? { key, fingerprint } : null;
      const found = topUpProblem(error);
      setProblem(found);
      if (found.field === 'amount') form.setError('amount', { message: 'Try a different amount' }, { shouldFocus: true });
      if (found.field === 'accountId') form.setError('accountId', { message: 'Choose another account' }, { shouldFocus: true });
      if (isApiError(error) && found.field) void queryClient.invalidateQueries({ queryKey: found.field === 'amount' ? qk.paymentsConfig : qk.accounts });
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  });

  const simulate = async (result: SimulatedOutcome, method: SimulatedMethod) => {
    const current = attemptRef.current;
    if (!current) return;
    setSheetBusy(result === 'success' ? 'pay' : 'decline');
    setSheetProblem(null);
    try {
      const proof = await api.payments.simulateTopUp(current.topUp.id, result, method);
      if (proof) await confirm(current, proof);
      else update(current.topUp.id, { stage: 'tracking', since: Date.now() });
    } catch (error) {
      setSheetProblem(describeError(error));
    } finally {
      setSheetBusy(null);
    }
  };

  const backToForm = () => change(null);

  if (attempt && (attempt.stage === 'confirming' || (tracking && (!outcome || outcome === 'pending')))) {
    return <Processing attempt={attempt} />;
  }
  if (attempt && (attempt.stage === 'failed' || outcome === 'failed')) {
    const reason = attempt.failure ?? (tracked.data?.failureReason ? humanize(tracked.data.failureReason) : null);
    return <Failure attempt={attempt} expired={tracked.data?.status === 'EXPIRED'} reason={reason} onRetry={backToForm} />;
  }
  if (attempt && tracked.data && outcome === 'credited') {
    return (
      <Receipt
        topUp={tracked.data}
        account={attempt.account}
        onNew={() => {
          form.reset({ accountId: attempt.account.id, amount: '' });
          backToForm();
        }}
      />
    );
  }
  if (attempt && tracked.data && outcome === 'returned') {
    return <Returned topUp={tracked.data} account={attempt.account} onDone={backToForm} />;
  }

  const blocked = kycStatus !== undefined && kycStatus !== 'VERIFIED';
  const exhausted = comparePaise(limits.remainingTodayPaise, '0') <= 0;
  return (
    <>
      <DetailsForm
        form={form}
        accounts={accounts}
        config={config}
        problem={problem}
        cancelled={cancelled}
        blocked={blocked}
        exhausted={exhausted}
        starting={starting || attempt?.stage === 'checkout'}
        onSubmit={start}
      />
      {config.mode === 'simulator' && attempt ? (
        <TestCheckoutSheet
          open={attempt.stage === 'checkout'}
          amountPaise={attempt.topUp.amountPaise}
          accountName={accountShortName(attempt.account)}
          busy={sheetBusy}
          problem={sheetProblem}
          onPay={(method) => void simulate('success', method)}
          onDecline={(method) => void simulate('failure', method)}
          onDismiss={() => void cancel(attempt)}
        />
      ) : null}
    </>
  );
}

type FormApi = ReturnType<typeof useForm<z.input<Schema>, unknown, z.output<Schema>>>;

function DetailsForm({
  form,
  accounts,
  config,
  problem,
  cancelled,
  blocked,
  exhausted,
  starting,
  onSubmit,
}: {
  form: FormApi;
  accounts: BankAccount[];
  config: PaymentConfig;
  problem: TopUpProblem | null;
  cancelled: boolean;
  blocked: boolean;
  exhausted: boolean;
  starting: boolean;
  onSubmit: () => void;
}) {
  const headingId = useId();
  const { errors } = form.formState;
  const { limits } = config;
  const [accountId, amountText] = form.watch(['accountId', 'amount']);
  const balances = useBalances(accounts.map((a) => a.id));
  const balance = balances[accounts.findIndex((a) => a.id === accountId)]?.data?.balanceInPaise;
  const typed = parseRupees(amountText ?? '');
  const ceiling = minPaise(limits.maxPaise, limits.remainingTodayPaise);

  return (
    <Card role="region" aria-labelledby={headingId}>
      <form onSubmit={onSubmit} noValidate>
        <div className="space-y-6 px-5 pb-7 pt-5 sm:px-7 sm:pt-7">
          <div className="space-y-1">
            <h2 id={headingId} className="text-title-3">
              Top up your account
            </h2>
            <p className="text-pretty text-[14px] leading-5 text-muted-foreground">The money arrives as soon as your payment is confirmed.</p>
          </div>
          {blocked ? (
            <Callout tone="warning" title="Identity verification pending">
              You can add money once we’ve verified your identity.
            </Callout>
          ) : exhausted ? (
            <Callout tone="warning" title="You’ve reached today’s limit">
              You can add up to {formatPaise(limits.dailyLimitPaise)} a day. Try again tomorrow.
            </Callout>
          ) : null}
          {cancelled ? (
            <Callout tone="info" title="Payment cancelled">
              You haven’t been charged. Start again whenever you’re ready.
            </Callout>
          ) : null}
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
            </Callout>
          ) : null}

          <Field label="To account" error={errors.accountId?.message} hint={balance ? `Balance: ${formatPaise(balance)}` : undefined}>
            {(p) => (
              <Select {...p} {...form.register('accountId')}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountShortName(a)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="space-y-3">
            <Field
              label="Amount"
              error={errors.amount?.message}
              hint={`${formatPaise(limits.remainingTodayPaise)} left today. Up to ${formatPaise(limits.maxPaise)} per payment.`}
            >
              {(p) => <AmountField {...p} {...form.register('amount')} />}
            </Field>
            <div role="group" aria-label="Quick amounts" className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
              {QUICK_AMOUNTS.map((paise) => {
                const pressed = typed === paise;
                return (
                  <button
                    key={paise}
                    type="button"
                    aria-pressed={pressed}
                    disabled={comparePaise(paise, ceiling) > 0 || comparePaise(paise, limits.minPaise) < 0}
                    onClick={() => form.setValue('amount', String(BigInt(paise) / 100n), { shouldValidate: Boolean(errors.amount) })}
                    className={cn(
                      'h-11 min-w-0 cursor-pointer rounded-full bg-muted px-2 text-[14px] font-medium tracking-[-0.01em] tnum transition-colors duration-200 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 sm:h-9 sm:px-4',
                      pressed && 'bg-primary-soft text-primary hover:bg-primary-soft'
                    )}
                  >
                    {rupees(paise)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex gap-3 text-[13px] leading-[18px] text-muted-foreground">
            <ShieldCheck className="mt-px size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <p className="text-pretty">
              Pay with UPI, cards and net banking.{' '}
              {config.mode === 'simulator'
                ? 'Test mode: payments are simulated and no real money moves.'
                : `Payments are processed securely by Razorpay${config.mode === 'test' ? ' (test mode)' : ''}.`}
            </p>
          </div>
        </div>
        <TileFooter>
          <Button type="submit" size="lg" className="w-full sm:w-auto" loading={starting} disabled={blocked || exhausted}>
            Continue <ArrowRight aria-hidden="true" />
          </Button>
        </TileFooter>
      </form>
    </Card>
  );
}

/** A heading that takes focus when its view appears, so keyboard and screen-reader users land on the outcome */
function OutcomeHeading({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} id={id} tabIndex={-1} className={cn('text-title-3 outline-none focus:outline-none', className)}>
      {children}
    </h2>
  );
}

function SummaryRow({ label, children, mark }: { label: string; children: ReactNode; mark?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <dt className="shrink-0 text-[15px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-3 text-right text-[15px] font-medium tracking-[-0.01em]">
        <span className="min-w-0 break-words">{children}</span>
        {mark ? <span className="flex w-10 shrink-0 justify-center">{mark}</span> : null}
      </dd>
    </div>
  );
}

const heroAmount = 'text-[44px] font-semibold leading-[48px] tracking-[-0.04em] sm:text-[56px] sm:leading-[60px]';

function Processing({ attempt }: { attempt: Attempt }) {
  const headingId = useId();
  const now = useNow(5_000);
  const slow = now - attempt.since > SLOW_AFTER_MS;
  return (
    <Card role="region" aria-labelledby={headingId} aria-busy="true">
      <div className="flex flex-col items-center px-5 py-12 text-center sm:px-8 sm:py-14">
        <Loader2 className="size-9 animate-spin text-muted-foreground" strokeWidth={1.6} aria-hidden="true" />
        <OutcomeHeading id={headingId} className="mt-5">
          Confirming your payment
        </OutcomeHeading>
        <p className={cn('mt-3', heroAmount)}>
          <BigAmount paise={attempt.topUp.amountPaise} />
        </p>
        <p className="mt-3 text-[15px] text-muted-foreground">
          to <span className="font-medium text-foreground">{accountShortName(attempt.account)}</span>
        </p>
        <p className="mt-6 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground" aria-live="polite">
          {slow
            ? 'This is taking longer than usual. You can leave this page: the money is added as soon as the payment is confirmed, and you’ll see it in your recent top-ups.'
            : 'This usually takes a few seconds.'}
        </p>
      </div>
    </Card>
  );
}

function Receipt({ topUp, account, onNew }: { topUp: TopUp; account: BankAccount; onNew: () => void }) {
  const headingId = useId();
  const at = topUp.creditedAt ?? topUp.updatedAt;
  const method = methodLabel(topUp.method);
  const reference = topUp.providerPaymentId ?? topUp.id;
  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex flex-col items-center px-5 pt-10 text-center sm:px-7 sm:pt-12">
        <span
          className="flex size-16 items-center justify-center rounded-full bg-success text-success-foreground duration-500 ease-spring animate-in fade-in-0 zoom-in-50"
          aria-hidden="true"
        >
          <Check className="size-8" strokeWidth={2.75} />
        </span>
        <OutcomeHeading id={headingId} className="mt-5">
          Money added
        </OutcomeHeading>
        <p className={cn('mt-3', heroAmount)}>
          <BigAmount paise={topUp.amountPaise} />
        </p>
        <p className="mt-3 text-[15px] text-muted-foreground">
          to <span className="font-medium text-foreground">{accountShortName(account)}</span>
        </p>
      </div>
      <dl className="mx-5 mb-3 mt-9 divide-y divide-border/70 border-t border-border/70 sm:mx-7">
        <SummaryRow label="To" mark={<AccountSwatch type={account.accountType} />}>
          {accountShortName(account)}
        </SummaryRow>
        {method ? <SummaryRow label="Paid with">{method}</SummaryRow> : null}
        <SummaryRow label="Reference">
          <span className="inline-flex max-w-full items-center gap-0.5">
            <span className="break-all text-[14px] tnum">{reference}</span>
            <CopyButton value={reference} label="Copy reference" className="relative -mr-1.5 shrink-0 after:absolute after:-inset-1.5" />
          </span>
        </SummaryRow>
        <SummaryRow label="Date">{`${formatDate(at)}, ${formatTime(at)}`}</SummaryRow>
      </dl>
      <TileFooter sticky={false}>
        <Button variant="secondary" size="lg" onClick={onNew}>
          Add more money
        </Button>
        <Button asChild size="lg">
          <Link to={`/accounts/${account.id}`}>View account</Link>
        </Button>
      </TileFooter>
    </Card>
  );
}

function Failure({ attempt, expired, reason, onRetry }: { attempt: Attempt; expired: boolean; reason: string | null; onRetry: () => void }) {
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex flex-col items-center px-5 pb-8 pt-10 text-center sm:px-8 sm:pt-12">
        <span className="flex size-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground" aria-hidden="true">
          <X className="size-8" strokeWidth={2.75} />
        </span>
        <OutcomeHeading id={headingId} className="mt-5">
          {expired ? 'Payment expired' : 'Payment failed'}
        </OutcomeHeading>
        <p className="mt-2 text-[15px] text-muted-foreground">
          {formatPaise(attempt.topUp.amountPaise)} to {accountShortName(attempt.account)}
        </p>
        {reason ? <p className="mt-4 max-w-sm text-pretty text-[15px] font-medium leading-[22px]">{reason}</p> : null}
        <p className="mt-3 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">
          No money was added. If your bank shows a deduction, it’s returned to you automatically within a few working days.
        </p>
      </div>
      <TileFooter sticky={false}>
        <Button size="lg" onClick={onRetry}>
          <RotateCcw aria-hidden="true" /> Try again
        </Button>
      </TileFooter>
    </Card>
  );
}

function Returned({ topUp, account, onDone }: { topUp: TopUp; account: BankAccount; onDone: () => void }) {
  const headingId = useId();
  const refunded = topUp.status === 'REFUNDED';
  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex flex-col items-center px-5 pb-8 pt-10 text-center sm:px-8 sm:pt-12">
        <Undo2 className="size-10 text-warning" strokeWidth={1.6} aria-hidden="true" />
        <OutcomeHeading id={headingId} className="mt-5">
          We couldn’t add this money
        </OutcomeHeading>
        <p className="mt-3 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">
          Your payment of {formatPaise(topUp.amountPaise)} went through, but {accountShortName(account)} can’t receive it right now.{' '}
          {refunded ? 'We’ve refunded it to you.' : 'We’re refunding it to you; refunds usually arrive within 5–7 working days.'}
        </p>
      </div>
      <TileFooter sticky={false}>
        <Button size="lg" onClick={onDone}>
          Done
        </Button>
      </TileFooter>
    </Card>
  );
}
