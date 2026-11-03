import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock, Search, UserRound } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import type { AccountLookup, CashOperationResult, CashOperationType } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { newIdempotencyKey } from '@/lib/notify';
import { qk } from '@/lib/query';
import { accountNumberSchema, maskAccountNumber, rupeesSchema } from '@/lib/validation';
import { useStepUp } from '@/features/security/StepUp';
import { ACCOUNT_TYPE_LABEL, LargeMoneyInput, formatDateTime, shortId } from '@/features/branch/components/cash';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Avatar, Callout, CopyButton, DescriptionList, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';

const findSchema = z.object({ accountNumber: accountNumberSchema });

const noteSchema = z.string().trim().max(255, 'Use at most 255 characters');
const codeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{8}$/, 'Enter the customer’s 8-digit code'));

const depositSchema = z.object({ amount: rupeesSchema(), note: noteSchema, code: z.string() });
const withdrawalSchema = z.object({ amount: rupeesSchema(), note: noteSchema, code: codeSchema });

type DetailsInput = z.input<typeof depositSchema>;
interface Intent {
  amountInPaise: string;
  description?: string;
  authorizationCode?: string;
}

type Step =
  | { kind: 'find' }
  | { kind: 'details'; account: AccountLookup }
  | { kind: 'review'; account: AccountLookup; intent: Intent; key: string }
  | { kind: 'done'; account: AccountLookup; intent: Intent; result: CashOperationResult };

const WORDS: Record<CashOperationType, { noun: string; title: string }> = {
  DEPOSIT: { noun: 'deposit', title: 'Deposit' },
  WITHDRAWAL: { noun: 'withdrawal', title: 'Withdrawal' },
};

/** The two cash transactions a teller can start: a two-segment control, then the steps of the chosen one */
export function CashDesk() {
  const [tab, setTab] = useState<'deposit' | 'withdrawal'>('deposit');
  const [busy, setBusy] = useState(false);
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
      <TabsList aria-label="Transaction type" className="grid h-11 w-full grid-cols-2 p-1 sm:max-w-sm">
        <TabsTrigger value="deposit" disabled={busy} className="h-9 text-[15px]">
          Deposit
        </TabsTrigger>
        <TabsTrigger value="withdrawal" disabled={busy} className="h-9 text-[15px]">
          Withdrawal
        </TabsTrigger>
      </TabsList>
      <TabsContent value="deposit" className="mt-6">
        <CashFlow type="DEPOSIT" onBusyChange={setBusy} />
      </TabsContent>
      <TabsContent value="withdrawal" className="mt-6">
        <CashFlow type="WITHDRAWAL" onBusyChange={setBusy} />
      </TabsContent>
    </Tabs>
  );
}

interface Problem {
  title: string;
  body: string;
  reference?: string;
}

/** What a failed cash request means at the counter, and what to do next */
function problemFor(error: unknown, type: CashOperationType, amount: string): Problem {
  const code = isApiError(error) ? error.code : '';
  switch (code) {
    case 'WITHDRAWAL_NOT_AUTHORISED':
      return {
        title: 'The withdrawal code wasn’t accepted',
        body: `It must be the customer’s newest code, created for this account and exactly ${formatPaise(amount)}, and not yet expired. Ask the customer to check it, or to create a new one. Repeated wrong codes cancel all of the customer’s codes.`,
      };
    case 'NO_TELLER_SESSION':
      return { title: 'Your cash session isn’t open', body: 'No money was moved. Your desk will refresh to show your session’s current state.' };
    case 'STALE_TELLER_SESSION':
      return {
        title: 'Your session is from a previous business day',
        body: 'No money was moved. Close it with your end-of-day count before handling cash today.',
      };
    case 'INSUFFICIENT_FUNDS':
      return {
        title: 'Not enough balance',
        body: 'The account doesn’t have enough money for this withdrawal. Don’t pay out any cash. The customer can withdraw a smaller amount with a new code.',
      };
    case 'ACCOUNT_INACTIVE':
      return { title: 'This account is frozen or closed', body: 'No money was moved. Ask the customer to contact the bank.' };
    case 'FORBIDDEN':
      return {
        title: 'You can’t handle this transaction',
        body: 'Staff can’t handle cash for their own accounts. Ask a colleague to serve this customer.',
      };
    case 'DAILY_LIMIT_EXCEEDED':
      return {
        title: 'Daily limit reached',
        body:
          type === 'WITHDRAWAL'
            ? 'This withdrawal would take the account past today’s limit. Don’t pay out any cash. The customer can withdraw less, with a new code, or come back tomorrow.'
            : 'This would take the account past today’s limit. No money was moved.',
      };
    default: {
      const { title, description, reference } = describeError(error);
      return { title, body: description, reference };
    }
  }
}

function ProblemCallout({ problem }: { problem: Problem }) {
  return (
    <Callout tone="danger" title={problem.title}>
      <p>{problem.body}</p>
      {problem.reference ? <p className="font-mono text-[11.5px]">Reference: {problem.reference}</p> : null}
    </Callout>
  );
}

function CashFlow({ type, onBusyChange }: { type: CashOperationType; onBusyChange: (busy: boolean) => void }) {
  const api = useApi();
  const user = useUser();
  const queryClient = useQueryClient();
  const { run } = useStepUp();
  const words = WORDS[type];
  const headingId = useId();

  const [step, setStep] = useState<Step>({ kind: 'find' });
  const [lookupProblem, setLookupProblem] = useState<Problem | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** One idempotency key per intent: retries of identical details reuse it, anything changed gets a new one */
  const intentRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);

  const findForm = useForm({ resolver: zodResolver(findSchema), defaultValues: { accountNumber: '' } });
  const detailsForm = useForm<DetailsInput, unknown, z.output<typeof depositSchema>>({
    resolver: zodResolver(type === 'WITHDRAWAL' ? withdrawalSchema : depositSchema),
    defaultValues: { amount: '', note: '', code: '' },
  });

  useEffect(() => onBusyChange(submitting), [submitting, onBusyChange]);
  useEffect(() => {
    // Move focus to the new step's heading so it is announced, and so a second Enter can't confirm unread
    if (step.kind === 'done' || step.kind === 'review') resultRef.current?.focus();
  }, [step.kind]);

  const startOver = () => {
    findForm.reset({ accountNumber: '' });
    detailsForm.reset({ amount: '', note: '', code: '' });
    intentRef.current = null;
    setProblem(null);
    setLookupProblem(null);
    setStep({ kind: 'find' });
    setTimeout(() => findForm.setFocus('accountNumber'), 0);
  };

  const onFind = findForm.handleSubmit(async ({ accountNumber }) => {
    setLookupProblem(null);
    try {
      const account = await api.accounts.lookup(accountNumber);
      detailsForm.reset({ amount: '', note: '', code: '' });
      setProblem(null);
      setStep({ kind: 'details', account });
    } catch (error) {
      if (isApiError(error) && error.code === 'NOT_FOUND') {
        findForm.setError('accountNumber', { message: 'No account has this number. Check it with the customer.' }, { shouldFocus: true });
      } else if (isApiError(error) && error.fieldErrors.accountNumber) {
        findForm.setError('accountNumber', { message: error.fieldErrors.accountNumber }, { shouldFocus: true });
      } else {
        setLookupProblem(problemFor(error, type, '0'));
      }
    }
  });

  const onReview = detailsForm.handleSubmit(({ amount, note, code }) => {
    if (step.kind !== 'details') return;
    const intent: Intent = {
      amountInPaise: amount,
      ...(note ? { description: note } : {}),
      ...(type === 'WITHDRAWAL' ? { authorizationCode: code } : {}),
    };
    const fingerprint = JSON.stringify([type, step.account.id, intent.amountInPaise, intent.description ?? '', intent.authorizationCode ?? '']);
    if (intentRef.current?.fingerprint !== fingerprint) intentRef.current = { fingerprint, key: newIdempotencyKey() };
    setProblem(null);
    setStep({ kind: 'review', account: step.account, intent, key: intentRef.current.key });
  });

  const submit = async () => {
    if (step.kind !== 'review') return;
    const { account, intent, key } = step;
    setSubmitting(true);
    setProblem(null);
    try {
      const base = { accountId: account.id, amountInPaise: intent.amountInPaise, ...(intent.description ? { description: intent.description } : {}) };
      const result = await run(() =>
        type === 'DEPOSIT'
          ? api.teller.deposit(base, key)
          : api.teller.withdraw({ ...base, authorizationCode: intent.authorizationCode ?? '' }, key)
      );
      intentRef.current = null;
      setStep({ kind: 'done', account, intent, result });
      void queryClient.invalidateQueries({ queryKey: qk.cashOperationsAll });
    } catch (error) {
      setProblem(problemFor(error, type, intent.amountInPaise));
      if (!isApiError(error)) return;
      if (error.code === 'WITHDRAWAL_NOT_AUTHORISED') {
        // The code is single-use and attempt-limited: ask for it again rather than resending it
        detailsForm.setValue('code', '');
        setStep({ kind: 'details', account });
        setTimeout(() => detailsForm.setFocus('code'), 0);
      } else if (error.code === 'VALIDATION_ERROR') {
        const fields = error.fieldErrors;
        if (fields.amountInPaise) detailsForm.setError('amount', { message: fields.amountInPaise });
        if (fields.description) detailsForm.setError('note', { message: fields.description });
        if (fields.authorizationCode) detailsForm.setError('code', { message: fields.authorizationCode });
        setStep({ kind: 'details', account });
      } else if (error.code === 'NO_TELLER_SESSION' || error.code === 'STALE_TELLER_SESSION') {
        void queryClient.invalidateQueries({ queryKey: qk.tellerSession });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (step.kind === 'find') {
    return (
      <form onSubmit={onFind} noValidate className="space-y-4">
        {lookupProblem ? <ProblemCallout problem={lookupProblem} /> : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Field
            label="Account number"
            error={findForm.formState.errors.accountNumber?.message}
            hint="12 digits. Spaces are fine."
            className="min-w-0 flex-1 sm:max-w-sm"
          >
            {(p) => (
              <Input
                {...p}
                {...findForm.register('accountNumber')}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                placeholder="1001 2345 6789"
                className="h-12 text-[19px] font-medium tracking-[0.06em] tnum placeholder:font-normal placeholder:tracking-[0.06em] sm:text-[19px]"
                autoFocus
              />
            )}
          </Field>
          <Button type="submit" size="lg" className="sm:mt-[26px]" loading={findForm.formState.isSubmitting}>
            <Search aria-hidden="true" /> Find account
          </Button>
        </div>
      </form>
    );
  }

  const { account } = step;
  const ownAccount = account.customerId === user.id;
  const blocked = ownAccount || account.status !== 'ACTIVE';

  if (step.kind === 'done') {
    const executed = step.result.status === 'EXECUTED';
    return (
      <section aria-labelledby={headingId} className="space-y-6">
        <div className="text-center">
          {executed ? (
            <CheckCircle2 className="mx-auto size-10 text-success" strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Clock className="mx-auto size-10 text-warning" strokeWidth={1.6} aria-hidden="true" />
          )}
          <h3 id={headingId} ref={resultRef} tabIndex={-1} className="mt-3 text-title-3 outline-none">
            {executed ? `${words.title} completed` : 'Sent to a supervisor for approval'}
          </h3>
          <p className="mt-1 text-[32px] font-semibold leading-10 tracking-[-0.03em] tnum">{formatPaise(step.intent.amountInPaise)}</p>
          {executed ? (
            <p className="mx-auto mt-2 max-w-md text-pretty text-[15px] leading-[22px] text-muted-foreground">
              {type === 'WITHDRAWAL'
                ? `Hand ${formatPaise(step.intent.amountInPaise)} to the customer now.`
                : 'Put the cash in your drawer and give the customer the reference.'}
            </p>
          ) : (
            <div className="mx-auto mt-2 max-w-md space-y-2 text-pretty text-[15px] leading-[22px] text-muted-foreground">
              <p>
                This {words.noun} is above the single-approval limit, or it would take your total for today past your daily limit, so a
                second person must approve it.
              </p>
              <p className="font-medium text-foreground">
                {type === 'WITHDRAWAL'
                  ? 'Don’t hand over any cash until it’s approved. If it’s rejected, the customer will need a new withdrawal code.'
                  : 'Keep the customer’s cash separate from your drawer until it’s approved.'}
              </p>
            </div>
          )}
        </div>
        <DescriptionList
          className="rounded-2xl bg-muted/60 px-4"
          items={[
            executed && step.result.status === 'EXECUTED'
              ? {
                  label: 'Reference',
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono text-[13px]">{step.result.transaction.referenceId}</span>
                      <CopyButton value={step.result.transaction.referenceId} label="Copy reference" />
                    </span>
                  ),
                }
              : { label: 'Request', value: <span className="font-mono text-[13px]">{shortId(step.result.cashOperationId)}</span> },
            { label: 'Account', value: <AccountLine account={account} /> },
            ...(step.result.status === 'EXECUTED' ? [{ label: 'Time', value: formatDateTime(step.result.transaction.createdAt) }] : []),
          ]}
        />
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button size="lg" className="w-full sm:w-auto sm:min-w-48" onClick={startOver}>
            New {words.noun}
          </Button>
          {executed ? null : (
            <Button variant="link" asChild>
              <Link to="/teller/operations">Track it in My operations</Link>
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (step.kind === 'review') {
    return (
      <section aria-labelledby={headingId} className="space-y-5">
        <h3 id={headingId} ref={resultRef} tabIndex={-1} className="text-headline outline-none">
          Check the details with the customer
        </h3>
        {problem ? <ProblemCallout problem={problem} /> : null}
        <div className="rounded-2xl bg-muted/60 px-5 py-7 text-center">
          <p className="text-[13px] font-medium text-muted-foreground">Cash {words.noun}</p>
          <p className="mt-1 text-[40px] font-semibold leading-[44px] tracking-[-0.04em] tnum sm:text-[48px] sm:leading-[52px]">
            {formatPaise(step.intent.amountInPaise)}
          </p>
        </div>
        <DescriptionList
          items={[
            { label: 'Account', value: <AccountLine account={account} /> },
            ...(step.intent.description ? [{ label: 'Note', value: step.intent.description }] : []),
            ...(step.intent.authorizationCode
              ? [{ label: 'Withdrawal code', value: `Entered, ending ${step.intent.authorizationCode.slice(-2)}` }]
              : []),
          ]}
        />
        {type === 'WITHDRAWAL' ? (
          <p className="text-[13px] leading-[18px] text-muted-foreground">Hand over cash only after you see the confirmation.</p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            size="lg"
            disabled={submitting}
            onClick={() => {
              setProblem(null);
              setStep({ kind: 'details', account });
            }}
          >
            <ArrowLeft aria-hidden="true" /> Edit
          </Button>
          <Button size="lg" className="sm:min-w-48" onClick={submit} loading={submitting}>
            Confirm {words.noun}
          </Button>
        </div>
      </section>
    );
  }

  // details
  const errors = detailsForm.formState.errors;
  return (
    <div className="space-y-5">
      <AccountSummary account={account} onChange={startOver} />
      {ownAccount ? (
        <Callout tone="danger" title="This is your own account">
          Staff can’t handle cash for their own accounts. Ask a colleague to serve you.
        </Callout>
      ) : account.status !== 'ACTIVE' ? (
        <Callout tone="danger" title={`This account is ${account.status.toLowerCase()}`}>
          Cash can’t be paid in or out of it. Ask the customer to contact the bank.
        </Callout>
      ) : null}
      {blocked ? null : (
        <form onSubmit={onReview} noValidate className="space-y-5">
          {problem ? <ProblemCallout problem={problem} /> : null}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Amount" error={errors.amount?.message}>
              {(p) => <LargeMoneyInput {...p} {...detailsForm.register('amount')} autoFocus />}
            </Field>
            {type === 'WITHDRAWAL' ? (
              <Field
                label="Customer’s withdrawal code"
                error={errors.code?.message}
                hint="The 8-digit code the customer made in their app for this account and this exact amount. Codes expire after a few minutes."
              >
                {(p) => (
                  <Input
                    {...p}
                    {...detailsForm.register('code')}
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={12}
                    placeholder="•••• ••••"
                    className="h-14 text-[22px] font-semibold tracking-[0.18em] tnum placeholder:font-normal sm:text-[22px]"
                  />
                )}
              </Field>
            ) : (
              <NoteField register={detailsForm.register('note')} error={errors.note?.message} />
            )}
          </div>
          {type === 'WITHDRAWAL' ? <NoteField register={detailsForm.register('note')} error={errors.note?.message} /> : null}
          <div className="flex justify-end">
            <Button type="submit" size="lg" className="w-full sm:w-auto sm:min-w-48">
              Review {words.noun}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function NoteField({ register, error }: { register: UseFormRegisterReturn<'note'>; error?: string }) {
  return (
    <Field label="Note" optional error={error} hint="Shown on the customer’s statement.">
      {(p) => <Input {...p} {...register} maxLength={255} autoComplete="off" />}
    </Field>
  );
}

function useHolderName(customerId: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.customer(customerId),
    queryFn: () => api.customers.get(customerId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function HolderName({ customerId, className }: { customerId: string; className?: string }) {
  const holder = useHolderName(customerId);
  if (holder.isPending) return <Skeleton className="inline-block h-5 w-32 align-middle" />;
  if (holder.isError || !holder.data) return <span className="text-muted-foreground">Name unavailable</span>;
  return <span className={className ?? 'font-medium'}>{holder.data.fullName}</span>;
}

/** The holder's monogram once their name is known (the same cached read as the name) */
function HolderAvatar({ customerId }: { customerId: string }) {
  const holder = useHolderName(customerId);
  if (holder.isPending) return <Skeleton className="size-11 shrink-0 rounded-full" />;
  if (!holder.data) {
    return (
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        <UserRound className="size-5" strokeWidth={1.8} />
      </span>
    );
  }
  return <Avatar name={holder.data.fullName} className="size-11 text-[15px]" />;
}

function AccountLine({ account }: { account: AccountLookup }) {
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
      <HolderName customerId={account.customerId} />
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span className="tnum text-muted-foreground">
        {ACCOUNT_TYPE_LABEL[account.accountType]} {maskAccountNumber(account.accountNumber)}
      </span>
    </span>
  );
}

/** Who the teller is serving: confirmed before any amount is entered */
function AccountSummary({ account, onChange }: { account: AccountLookup; onChange: () => void }) {
  return (
    <div className="relative flex items-center gap-3.5 rounded-2xl bg-muted/60 p-4" aria-label="Customer account" role="group">
      <HolderAvatar customerId={account.customerId} />
      <div className="min-w-0 flex-1">
        {/* Phones: "Change" sits in the top corner, so only the name line needs to make room for it */}
        <p className="truncate text-headline max-sm:pr-20">
          <HolderName customerId={account.customerId} className="" />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] text-muted-foreground">
          <span>{ACCOUNT_TYPE_LABEL[account.accountType]}</span>
          <span className="whitespace-nowrap tnum text-foreground">{maskAccountNumber(account.accountNumber)}</span>
          <StatusBadge status={account.status} className="ml-1" />
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={onChange} className="shrink-0 max-sm:absolute max-sm:right-3 max-sm:top-3">
        Change
      </Button>
    </div>
  );
}
