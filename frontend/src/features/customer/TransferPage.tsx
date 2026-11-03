import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronLeft, Plus, Wallet } from 'lucide-react';
import type { BankAccount, Beneficiary, TransactionResult, TransferInput } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { comparePaise, formatPaise, paiseToInput, parseRupees } from '@/lib/money';
import { newIdempotencyKey } from '@/lib/notify';
import { formatAccountNumber, maskAccountNumber, rupeesSchema } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { useStepUp } from '@/features/security/StepUp';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Field, Input } from '@/components/ui/input';
import { Avatar, BigAmount, Callout, Card, CopyButton, EmptyState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { useAccounts, useBalances, useBeneficiaries, useNow } from './hooks';
import { POLICY, accountShortName, formatDate, formatDateTime, formatTime, paiseInMessage } from './lib';
import { AccountSwatch } from './components/AccountCard';
import { AmountField } from './components/AmountField';
import { Select } from './components/Select';
import { StepProgress } from './components/StepProgress';
import { TileFooter } from './components/TileFooter';

const STEPS = ['Details', 'Review', 'Done'] as const;
type Step = 'details' | 'review' | 'receipt';
type Mode = 'own' | 'payee';

interface DetailsForm {
  sourceAccountId: string;
  mode: Mode;
  destinationAccountId: string;
  beneficiaryId: string;
  amount: string;
  note: string;
}

const detailsSchema = z
  .object({
    sourceAccountId: z.string(),
    mode: z.enum(['own', 'payee']),
    destinationAccountId: z.string(),
    beneficiaryId: z.string(),
    amount: z.string(),
    note: z.string(),
  })
  .superRefine((v, ctx) => {
    if (!v.sourceAccountId) ctx.addIssue({ code: 'custom', path: ['sourceAccountId'], message: 'Choose the account to send from' });
    if (v.mode === 'own' && !v.destinationAccountId) {
      ctx.addIssue({ code: 'custom', path: ['destinationAccountId'], message: 'Choose the account to send to' });
    }
    if (v.mode === 'payee' && !v.beneficiaryId) ctx.addIssue({ code: 'custom', path: ['beneficiaryId'], message: 'Choose a payee' });
    const amount = rupeesSchema().safeParse(v.amount);
    if (!amount.success) ctx.addIssue({ code: 'custom', path: ['amount'], message: amount.error.issues[0]?.message ?? 'Enter an amount' });
    if (v.note.trim().length > 255) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Keep the note to 255 characters or fewer' });
  });

/** One intent to move money: what the customer reviewed, and what will be sent */
interface Draft {
  input: TransferInput;
  source: BankAccount;
  destinationLabel: string;
  destinationDetail: string;
  payee: Beneficiary | null;
  amountPaise: string;
  note: string;
  /** Identifies the intent, so a retry of the same transfer reuses its idempotency key */
  fingerprint: string;
}

interface Problem {
  title: string;
  description: string;
  payeeLink?: boolean;
}

const isPayeeActive = (payee: Beneficiary, now: number) => new Date(payee.activatesAt).getTime() <= now;
const isNewPayee = (payee: Beneficiary, now: number) => isPayeeActive(payee, now) && now - new Date(payee.activatesAt).getTime() < 24 * 3600_000;
const payeeLabel = (payee: Beneficiary) => `${payee.nickname} ${maskAccountNumber(payee.accountNumber)}`;
const whenLabel = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso));

/**
 * Was the outcome of this attempt left open (network, timeout, busy, server error, or a step-up the person
 * didn't finish)? Then the same intent must be retried with the SAME idempotency key, so it can never be
 * processed twice.
 */
function isUnsettled(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return error.isRetryable || error.status >= 500 || error.status === 0 || error.code === 'IDEMPOTENCY_CONFLICT' || error.requiresStepUp;
}

function reviewProblemFrom(error: unknown, hasAuthenticator: boolean): Problem {
  if (isApiError(error) && error.requiresStepUp) {
    const threshold = formatPaise(POLICY.transferStepUpPaise);
    return hasAuthenticator
      ? {
          title: 'Authenticator code needed',
          description: `Transfers of ${threshold} or more must be approved with a code from your authenticator app. Send again when you’re ready.`,
        }
      : {
          title: 'Set up an authenticator first',
          description: `Transfers of ${threshold} or more must be approved with an authenticator app. Set one up in Security settings, or send a smaller amount.`,
        };
  }
  return describeError(error);
}

function detailsProblemFrom(error: unknown): Problem {
  const { title, description } = describeError(error);
  if (!isApiError(error)) return { title, description };
  switch (error.code) {
    case 'DAILY_LIMIT_EXCEEDED': {
      const remaining = paiseInMessage(error.message);
      if (remaining) return { title, description: `You can send up to ${remaining} more today from this account. Lower the amount, or try again tomorrow.` };
      if (/all your accounts/i.test(error.message)) {
        return { title, description: 'This would go over today’s limit across all your accounts. Lower the amount, or try again tomorrow.' };
      }
      return { title, description };
    }
    case 'BENEFICIARY_COOLING_OFF': {
      const at = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(error.message)?.[0];
      return at ? { title, description: `New payees can receive money after a short cooling-off period. This one becomes active at ${whenLabel(at)}.` } : { title, description };
    }
    case 'NEW_BENEFICIARY_LIMIT': {
      const cap = paiseInMessage(error.message) ?? formatPaise(POLICY.newPayeeLimitPaise);
      return { title, description: `A new payee can receive up to ${cap} in its first 24 hours. Send a smaller amount now and the rest later.` };
    }
    case 'BENEFICIARY_REQUIRED':
      return { title, description, payeeLink: true };
    default:
      return { title, description };
  }
}

/** One calm centred column, as for every single-task flow */
function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="large-title">Transfer money</h1>
      {children}
    </div>
  );
}

export default function TransferPage() {
  const accountsQuery = useAccounts();
  const payeesQuery = useBeneficiaries();
  const [params] = useSearchParams();

  if (accountsQuery.isError) {
    return (
      <PageShell>
        <Card>
          <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
        </Card>
      </PageShell>
    );
  }
  if (accountsQuery.isPending || payeesQuery.isPending) {
    return (
      <PageShell>
        <Skeleton className="h-1 w-full rounded-full" />
        <Card className="space-y-6 p-5 sm:p-7" aria-busy="true">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-[76px] w-full rounded-2xl" />
        </Card>
      </PageShell>
    );
  }
  const active = accountsQuery.data.filter((a) => a.status === 'ACTIVE');
  const payees = payeesQuery.data ?? [];
  // A transfer drafted by Sphere names the payee rather than identifying it: match the nickname exactly
  const payeeName = params.get('payeeName')?.trim() ?? '';
  const named = payeeName ? payees.find((p) => p.nickname.trim().toLowerCase() === payeeName.toLowerCase()) : undefined;
  if (active.length === 0) {
    return (
      <PageShell>
        <Card>
          <EmptyState
            icon={Wallet}
            title="No account to send from"
            description="You need an active account to send money. Open one, or contact the bank if your account is frozen."
            action={
              <Button asChild variant="secondary">
                <Link to="/accounts">Go to accounts</Link>
              </Button>
            }
          />
        </Card>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <TransferFlow
        accounts={active}
        payees={payees}
        payeesError={payeesQuery.error}
        onRetryPayees={() => void payeesQuery.refetch()}
        initialFrom={params.get('from')}
        initialPayee={params.get('payee') ?? named?.id ?? null}
        unknownPayee={payeeName && !named ? payeeName : null}
        initialAmount={params.get('amount')}
        initialNote={params.get('note')}
      />
    </PageShell>
  );
}

/** What a link can prefill (a payee from the Payees page, or a transfer drafted by Sphere); never sent unreviewed */
interface Prefill {
  from: string | null;
  payeeId: string | null;
  /** A payee was asked for by name but isn't one of the customer's */
  payeeWanted: boolean;
  /** Paise */
  amount: string | null;
  note: string | null;
}

function initialValues(accounts: BankAccount[], payees: Beneficiary[], prefill: Prefill): DetailsForm {
  const source = accounts.find((a) => a.id === prefill.from) ?? accounts[0];
  const others = accounts.filter((a) => a.id !== source?.id);
  const payee = payees.find((p) => p.id === prefill.payeeId);
  const mode: Mode = payee || prefill.payeeWanted || others.length === 0 ? 'payee' : 'own';
  const amount = prefill.amount && /^\d{1,18}$/.test(prefill.amount) && BigInt(prefill.amount) > 0n ? paiseToInput(prefill.amount) : '';
  return {
    sourceAccountId: source?.id ?? '',
    mode,
    destinationAccountId: others.length === 1 ? (others[0]?.id ?? '') : '',
    beneficiaryId: payee && isPayeeActive(payee, Date.now()) ? payee.id : '',
    amount,
    note: (prefill.note ?? '').trim().slice(0, 255),
  };
}

function TransferFlow({
  accounts,
  payees,
  payeesError,
  onRetryPayees,
  initialFrom,
  initialPayee,
  unknownPayee = null,
  initialAmount = null,
  initialNote = null,
}: {
  accounts: BankAccount[];
  payees: Beneficiary[];
  payeesError: unknown;
  onRetryPayees: () => void;
  initialFrom: string | null;
  initialPayee: string | null;
  unknownPayee?: string | null;
  initialAmount?: string | null;
  initialNote?: string | null;
}) {
  const { api, user } = useAuth();
  const { run } = useStepUp();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const balanceQueries = useBalances(accounts.map((a) => a.id));
  const balanceOf = (id: string) => balanceQueries[accounts.findIndex((a) => a.id === id)];

  const [defaults] = useState(() =>
    initialValues(accounts, payees, {
      from: initialFrom,
      payeeId: initialPayee,
      payeeWanted: Boolean(unknownPayee),
      amount: initialAmount,
      note: initialNote,
    })
  );
  const form = useForm<DetailsForm>({ resolver: zodResolver(detailsSchema), defaultValues: defaults });
  const [step, setStep] = useState<Step>('details');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reviewProblem, setReviewProblem] = useState<Problem | null>(null);
  const [detailsProblem, setDetailsProblem] = useState<Problem | null>(null);
  const [receipt, setReceipt] = useState<{ result: TransactionResult; draft: Draft } | null>(null);
  const inFlight = useRef(false);
  /** The last attempt whose outcome is unknown: retrying the same intent must reuse its key */
  const unsettled = useRef<{ key: string; fingerprint: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  useEffect(() => {
    // Move focus to the new step's heading so keyboard and screen-reader users land in the right place.
    // Compared with the step last shown (not a "mounted" flag), so a re-run effect never steals focus on load.
    if (shownStep.current !== step) headingRef.current?.focus();
    shownStep.current = step;
  }, [step]);

  const toReview = form.handleSubmit((values) => {
    const amountPaise = parseRupees(values.amount);
    const source = accounts.find((a) => a.id === values.sourceAccountId);
    if (!amountPaise || !source) return;
    const available = balanceOf(source.id)?.data?.balanceInPaise;
    if (available && comparePaise(amountPaise, available) > 0) {
      form.setError('amount', { message: `That’s more than the available balance of ${formatPaise(available)}.` }, { shouldFocus: true });
      return;
    }

    const note = values.note.trim();
    let input: TransferInput;
    let destinationLabel: string;
    let destinationDetail: string;
    let payee: Beneficiary | null = null;
    if (values.mode === 'own') {
      const destination = accounts.find((a) => a.id === values.destinationAccountId && a.id !== source.id);
      if (!destination) {
        form.setError('destinationAccountId', { message: 'Choose the account to send to' }, { shouldFocus: true });
        return;
      }
      input = { sourceAccountId: source.id, destinationAccountId: destination.id, amountInPaise: amountPaise };
      destinationLabel = accountShortName(destination);
      destinationDetail = `Your account ${formatAccountNumber(destination.accountNumber)}`;
    } else {
      payee = payees.find((p) => p.id === values.beneficiaryId) ?? null;
      if (!payee) {
        form.setError('beneficiaryId', { message: 'Choose a payee' }, { shouldFocus: true });
        return;
      }
      if (!isPayeeActive(payee, Date.now())) {
        form.setError('beneficiaryId', { message: `${payee.nickname} becomes active at ${whenLabel(payee.activatesAt)}` }, { shouldFocus: true });
        return;
      }
      input = { sourceAccountId: source.id, destinationAccountNumber: payee.accountNumber, amountInPaise: amountPaise };
      destinationLabel = payee.nickname;
      destinationDetail = `Payee account ${formatAccountNumber(payee.accountNumber)}`;
    }
    if (note) input.description = note;

    const fingerprint = JSON.stringify(input);
    // Same transfer as an attempt whose outcome is unknown: keep its key. Anything else is a new intent.
    setKey(unsettled.current?.fingerprint === fingerprint ? unsettled.current.key : newIdempotencyKey());
    setDraft({ input, source, destinationLabel, destinationDetail, payee, amountPaise, note, fingerprint });
    setDetailsProblem(null);
    setReviewProblem(null);
    setStep('review');
  });

  const send = async () => {
    if (!draft || !key || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setReviewProblem(null);
    const attemptKey = key;
    try {
      const result = await run(() => api.ledger.transfer(draft.input, attemptKey));
      unsettled.current = null;
      setReceipt({ result, draft });
      setStep('receipt');
      void queryClient.invalidateQueries({ queryKey: qk.balances });
      void queryClient.invalidateQueries({ queryKey: qk.historyAll });
      void queryClient.invalidateQueries({ queryKey: qk.accounts });
    } catch (error) {
      if (isUnsettled(error)) {
        unsettled.current = { key: attemptKey, fingerprint: draft.fingerprint };
        setReviewProblem(reviewProblemFrom(error, Boolean(user?.mfa)));
      } else {
        // Refused outright: nothing moved. The next attempt is a new intent with a new key.
        unsettled.current = null;
        setKey(null);
        setDetailsProblem(detailsProblemFrom(error));
        if (isApiError(error)) {
          const fields = error.fieldErrors;
          if (fields.amountInPaise) form.setError('amount', { message: fields.amountInPaise });
          if (fields.description) form.setError('note', { message: fields.description });
          if (error.code === 'ACCOUNT_INACTIVE') void queryClient.invalidateQueries({ queryKey: qk.accounts });
        }
        void queryClient.invalidateQueries({ queryKey: qk.balances });
        setStep('details');
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const startOver = () => {
    form.reset({ ...defaults, sourceAccountId: draft?.source.id ?? receipt?.draft.source.id ?? defaults.sourceAccountId, beneficiaryId: '' });
    setDraft(null);
    setKey(null);
    setReceipt(null);
    setDetailsProblem(null);
    setReviewProblem(null);
    setStep('details');
  };

  const stepIndex = step === 'details' ? 0 : step === 'review' ? 1 : 2;

  return (
    <div className="space-y-6">
      <StepProgress steps={STEPS} current={stepIndex} label="Transfer progress" />
      {step === 'details' ? (
        <DetailsStep
          form={form}
          accounts={accounts}
          payees={payees}
          payeesError={payeesError}
          onRetryPayees={onRetryPayees}
          balanceOf={balanceOf}
          now={now}
          problem={detailsProblem}
          initialPayee={payees.find((p) => p.id === initialPayee) ?? null}
          unknownPayee={unknownPayee}
          headingRef={headingRef}
          onSubmit={toReview}
        />
      ) : null}
      {step === 'review' && draft ? (
        <ReviewStep
          draft={draft}
          accounts={accounts}
          sending={sending}
          problem={reviewProblem}
          now={now}
          headingRef={headingRef}
          onSend={() => void send()}
          onEdit={() => {
            setReviewProblem(null);
            setKey(null);
            setStep('details');
          }}
        />
      ) : null}
      {step === 'receipt' && receipt ? <ReceiptStep {...receipt} accounts={accounts} headingRef={headingRef} onNew={startOver} /> : null}
    </div>
  );
}

type FormApi = ReturnType<typeof useForm<DetailsForm>>;
type BalanceState = ReturnType<typeof useBalances>[number] | undefined;

function StepHeading({
  headingRef,
  id,
  children,
  className,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      ref={headingRef}
      id={id}
      tabIndex={-1}
      className={cn('text-title-3 outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0', className)}
    >
      {children}
    </h2>
  );
}

/** One line of a summary: label on the left, value (and a quieter detail) on the right, then its mark */
function SummaryRow({ label, detail, mark, children }: { label: string; detail?: ReactNode; mark?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <dt className="shrink-0 text-[15px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-3 text-right">
        <span className="min-w-0">
          <span className="block break-words text-[15px] font-medium tracking-[-0.01em]">{children}</span>
          {detail ? <span className="block text-[13px] text-muted-foreground tnum">{detail}</span> : null}
        </span>
        {mark ? <span className="flex w-10 shrink-0 justify-center">{mark}</span> : null}
      </dd>
    </div>
  );
}

/** How the destination is drawn: an account's card swatch, or a payee's monogram */
function DestinationMark({ draft, accounts }: { draft: Draft; accounts: BankAccount[] }) {
  if (draft.payee) return <Avatar name={draft.payee.nickname} className="size-8" />;
  const destination = accounts.find((a) => a.id === draft.input.destinationAccountId);
  return destination ? <AccountSwatch type={destination.accountType} /> : null;
}

const heroAmount = 'text-[44px] font-semibold leading-[48px] tracking-[-0.04em] sm:text-[56px] sm:leading-[60px]';

function DetailsStep({
  form,
  accounts,
  payees,
  payeesError,
  onRetryPayees,
  balanceOf,
  now,
  problem,
  initialPayee,
  unknownPayee,
  headingRef,
  onSubmit,
}: {
  form: FormApi;
  accounts: BankAccount[];
  payees: Beneficiary[];
  payeesError: unknown;
  onRetryPayees: () => void;
  balanceOf: (id: string) => BalanceState;
  now: number;
  problem: Problem | null;
  initialPayee: Beneficiary | null;
  unknownPayee: string | null;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onSubmit: () => void;
}) {
  const headingId = useId();
  const { errors } = form.formState;
  const [sourceId, mode, beneficiaryId, amountText] = form.watch(['sourceAccountId', 'mode', 'beneficiaryId', 'amount']);
  const ownTargets = accounts.filter((a) => a.id !== sourceId);
  const balance = balanceOf(sourceId);
  const available = balance?.data?.balanceInPaise;
  const typed = parseRupees(amountText ?? '');
  const overBalance = Boolean(typed && available && comparePaise(typed, available) > 0);
  const selectedPayee = payees.find((p) => p.id === beneficiaryId);
  const waitingPayee = initialPayee && !isPayeeActive(initialPayee, now) && !beneficiaryId ? initialPayee : null;

  const sourceField = form.register('sourceAccountId', {
    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
      // Never leave the destination pointing at the new source account
      if (form.getValues('destinationAccountId') === event.target.value) {
        const others = accounts.filter((a) => a.id !== event.target.value);
        form.setValue('destinationAccountId', others.length === 1 ? (others[0]?.id ?? '') : '');
      }
    },
  });

  const addPayeeLink = (
    <Link to="/payees?add=1" className="inline-flex items-center gap-1 text-[14px] font-medium text-primary hover:underline">
      <Plus className="size-4" aria-hidden="true" /> Add a payee
    </Link>
  );

  return (
    <Card role="region" aria-labelledby={headingId}>
      <form onSubmit={onSubmit} noValidate>
        <div className="space-y-6 px-5 pb-7 pt-5 sm:px-7 sm:pt-7">
          <StepHeading headingRef={headingRef} id={headingId}>
            Transfer details
          </StepHeading>
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
              {problem.payeeLink ? <span className="mt-1 block">{addPayeeLink}</span> : null}
            </Callout>
          ) : null}
          {unknownPayee && !beneficiaryId ? (
            <Callout tone="warning" title={`We couldn’t find “${unknownPayee}” in your payees`}>
              Choose who to pay below, or add them as a payee first.
            </Callout>
          ) : null}
          {waitingPayee ? (
            <Callout tone="warning" title={`${waitingPayee.nickname} isn’t active yet`}>
              New payees can receive money after a cooling-off period. This one becomes active at {whenLabel(waitingPayee.activatesAt)}.
            </Callout>
          ) : null}

          <Field
            label="From"
            error={errors.sourceAccountId?.message}
            hint={
              available
                ? `Available balance: ${formatPaise(available)}`
                : balance?.isError
                  ? 'Balance unavailable right now'
                  : balance?.isPending
                    ? 'Checking the balance…'
                    : undefined
            }
          >
            {(p) => (
              <Select {...p} {...sourceField}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountShortName(a)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <fieldset className="space-y-2">
            <legend className="sr-only">To</legend>
            <div className="flex items-center justify-between gap-3">
              <span aria-hidden="true" className="text-[13px] font-medium tracking-[-0.005em]">
                To
              </span>
              {/* A segmented control made of real radios, so it works with the keyboard and the form library */}
              <div className="grid h-9 grid-cols-2 gap-0.5 rounded-full bg-muted p-[3px]">
                {(
                  [
                    ['own', 'My accounts'],
                    ['payee', 'Payee'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="flex h-[30px] cursor-pointer items-center justify-center whitespace-nowrap rounded-full px-4 text-[13px] font-medium tracking-[-0.005em] text-muted-foreground transition-[background-color,color,box-shadow] duration-200 hover:text-foreground has-[:checked]:bg-segment has-[:checked]:font-semibold has-[:checked]:text-foreground has-[:checked]:shadow-thumb has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                  >
                    <input type="radio" value={value} className="sr-only" {...form.register('mode')} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {mode === 'own' ? (
              ownTargets.length ? (
                <Field label={<span className="sr-only">To account</span>} error={errors.destinationAccountId?.message}>
                  {(p) => (
                    <Select {...p} {...form.register('destinationAccountId')}>
                      <option value="" disabled>
                        Select an account
                      </option>
                      {ownTargets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {accountShortName(a)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <p className="rounded-xl bg-muted px-4 py-3.5 text-[14px] leading-5 text-muted-foreground">
                  You don’t have another active account to send to. Choose <strong className="font-semibold text-foreground">Payee</strong> to
                  pay someone else.
                </p>
              )
            ) : payeesError ? (
              <Callout
                tone="danger"
                title="We couldn’t load your payees"
                action={
                  <Button variant="secondary" size="sm" onClick={onRetryPayees}>
                    Try again
                  </Button>
                }
              />
            ) : payees.length === 0 ? (
              <div className="space-y-2 rounded-xl bg-muted px-4 py-3.5 text-[14px] leading-5 text-muted-foreground">
                <p>You haven’t added any payees yet. Add someone’s account once, then pay them whenever you need to.</p>
                {addPayeeLink}
              </div>
            ) : (
              <div className="space-y-3">
                <Field
                  label={<span className="sr-only">Recipient</span>}
                  error={errors.beneficiaryId?.message}
                  hint={
                    selectedPayee && isNewPayee(selectedPayee, now)
                      ? `New payee: you can send up to ${formatPaise(POLICY.newPayeeLimitPaise)} in total during its first 24 hours.`
                      : payees.some((p) => !isPayeeActive(p, now))
                        ? 'Recently added payees become available after a cooling-off period.'
                        : undefined
                  }
                >
                  {(p) => (
                    <Select {...p} {...form.register('beneficiaryId')}>
                      <option value="" disabled>
                        Select a payee
                      </option>
                      {payees.map((payee) => {
                        const ready = isPayeeActive(payee, now);
                        return (
                          <option key={payee.id} value={payee.id} disabled={!ready}>
                            {payeeLabel(payee)}
                            {ready ? '' : ` — active from ${whenLabel(payee.activatesAt)}`}
                          </option>
                        );
                      })}
                    </Select>
                  )}
                </Field>
                {addPayeeLink}
              </div>
            )}
          </fieldset>

          <Field
            label="Amount"
            error={errors.amount?.message}
            hint={
              overBalance && available ? (
                <span className="font-medium text-warning">That’s more than the available balance of {formatPaise(available)}.</span>
              ) : undefined
            }
          >
            {(p) => <AmountField {...p} {...form.register('amount')} />}
          </Field>
          <Field label="Note" optional error={errors.note?.message} hint="Shown on your statement. Up to 255 characters.">
            {(p) => <Input {...p} {...form.register('note')} maxLength={255} autoComplete="off" />}
          </Field>
        </div>
        <TileFooter>
          <Button type="submit" size="lg" className="w-full sm:w-auto">
            Review transfer <ArrowRight aria-hidden="true" />
          </Button>
        </TileFooter>
      </form>
    </Card>
  );
}

function ReviewStep({
  draft,
  accounts,
  sending,
  problem,
  now,
  headingRef,
  onSend,
  onEdit,
}: {
  draft: Draft;
  accounts: BankAccount[];
  sending: boolean;
  problem: Problem | null;
  now: number;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onSend: () => void;
  onEdit: () => void;
}) {
  const headingId = useId();
  const highValue = comparePaise(draft.amountPaise, POLICY.transferStepUpPaise) >= 0;
  const newPayee = Boolean(draft.payee && isNewPayee(draft.payee, now));
  const amount = formatPaise(draft.amountPaise);
  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-7 sm:pt-7">
        <div className="min-w-0 space-y-1">
          <StepHeading headingRef={headingRef} id={headingId}>
            Review your transfer
          </StepHeading>
          <p className="text-pretty text-[14px] leading-5 text-muted-foreground">
            Check everything before you send.{draft.payee ? ' Money sent to someone else can’t be taken back.' : ''}
          </p>
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={onEdit} disabled={sending} aria-label="Edit details">
          <ChevronLeft aria-hidden="true" /> Edit
        </Button>
      </div>

      <div className="px-5 pt-9 text-center sm:px-7 sm:pt-10">
        <p className="text-[15px] font-medium text-muted-foreground">You’re sending</p>
        <p className={cn('mt-2', heroAmount)}>
          <BigAmount paise={draft.amountPaise} />
        </p>
        <p className="mt-3 text-[15px] text-muted-foreground">
          to <span className="font-medium text-foreground">{draft.destinationLabel}</span>
        </p>
      </div>

      <dl className="mx-5 mt-9 divide-y divide-border/70 border-t border-border/70 sm:mx-7">
        <SummaryRow label="From" detail={formatAccountNumber(draft.source.accountNumber)} mark={<AccountSwatch type={draft.source.accountType} />}>
          {accountShortName(draft.source)}
        </SummaryRow>
        <SummaryRow label="To" detail={draft.destinationDetail} mark={<DestinationMark draft={draft} accounts={accounts} />}>
          {draft.destinationLabel}
        </SummaryRow>
        <SummaryRow label="Note">{draft.note || <span className="font-normal text-muted-foreground">None</span>}</SummaryRow>
      </dl>

      {highValue || newPayee || problem ? (
        <div className="space-y-3 px-5 pb-6 pt-2 sm:px-7">
          {highValue ? (
            <Callout tone="info" title="Authenticator code needed">
              Amounts of {formatPaise(POLICY.transferStepUpPaise)} or more need a code from your authenticator app. We’ll ask for it when you send.
            </Callout>
          ) : null}
          {newPayee ? (
            <Callout tone="info" title="New payee">
              In a payee’s first 24 hours you can send them up to {formatPaise(POLICY.newPayeeLimitPaise)} in total.
            </Callout>
          ) : null}
          {problem ? (
            <Callout
              tone="danger"
              title={problem.title}
              action={
                <Button variant="secondary" size="sm" onClick={onSend} disabled={sending}>
                  Try again
                </Button>
              }
            >
              {problem.description} Trying again is safe: this transfer can only ever be made once.
            </Callout>
          ) : null}
        </div>
      ) : (
        <div className="pb-3" />
      )}

      <TileFooter>
        <Button size="lg" className="w-full sm:w-auto sm:min-w-[11rem]" onClick={onSend} loading={sending}>
          Send {amount}
        </Button>
      </TileFooter>
    </Card>
  );
}

function ReceiptStep({
  result,
  draft,
  accounts,
  headingRef,
  onNew,
}: {
  result: TransactionResult;
  draft: Draft;
  accounts: BankAccount[];
  headingRef: React.RefObject<HTMLHeadingElement>;
  onNew: () => void;
}) {
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId}>
      <div className="flex flex-col items-center px-5 pt-10 text-center sm:px-7 sm:pt-12">
        <span
          className="flex size-16 items-center justify-center rounded-full bg-success text-success-foreground duration-500 ease-spring animate-in fade-in-0 zoom-in-50"
          aria-hidden="true"
        >
          <Check className="size-8" strokeWidth={2.75} />
        </span>
        <StepHeading headingRef={headingRef} id={headingId} className="mt-5">
          Money sent
        </StepHeading>
        <p className={cn('mt-3', heroAmount)}>
          <BigAmount paise={result.amountInPaise} />
        </p>
        <p className="mt-3 text-[15px] text-muted-foreground">
          to <span className="font-medium text-foreground">{draft.destinationLabel}</span>
        </p>
      </div>

      <dl className="mx-5 mb-3 mt-9 divide-y divide-border/70 border-t border-border/70 sm:mx-7">
        <SummaryRow label="From" mark={<AccountSwatch type={draft.source.accountType} />}>
          {accountShortName(draft.source)}
        </SummaryRow>
        <SummaryRow label="To" detail={draft.destinationDetail} mark={<DestinationMark draft={draft} accounts={accounts} />}>
          {draft.destinationLabel}
        </SummaryRow>
        <SummaryRow label="Reference">
          <span className="inline-flex max-w-full items-center gap-0.5">
            <span className="break-all text-[14px] tnum">{result.referenceId}</span>
            <CopyButton value={result.referenceId} label="Copy reference" className="relative -mr-1.5 shrink-0 after:absolute after:-inset-1.5" />
          </span>
        </SummaryRow>
        <SummaryRow label="Date">{`${formatDate(result.createdAt)}, ${formatTime(result.createdAt)}`}</SummaryRow>
        {draft.note ? <SummaryRow label="Note">{draft.note}</SummaryRow> : null}
        <SummaryRow label="Status">
          <StatusBadge status={result.status} />
        </SummaryRow>
      </dl>

      <TileFooter sticky={false}>
        <Button variant="secondary" size="lg" onClick={onNew}>
          New transfer
        </Button>
        <Button asChild size="lg">
          <Link to={`/accounts/${draft.source.id}`}>View statement</Link>
        </Button>
      </TileFooter>
    </Card>
  );
}
