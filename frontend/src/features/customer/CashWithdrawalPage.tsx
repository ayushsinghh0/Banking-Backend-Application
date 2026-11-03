import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BadgeCheck, Banknote, IdCard, MailCheck, PhoneOff, RefreshCcw, TimerOff, Wallet } from 'lucide-react';
import type { BankAccount, WithdrawalCode } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/AuthProvider';
import { comparePaise, formatPaise, parseRupees } from '@/lib/money';
import { rupeesSchema } from '@/lib/validation';
import { useStepUp } from '@/features/security/StepUp';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Field } from '@/components/ui/input';
import { Callout, Card, CopyButton, EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useAccounts, useBalances, useNow } from './hooks';
import { POLICY, accountShortName, formatClock, formatTime } from './lib';
import { AmountField } from './components/AmountField';
import { Panel } from './components/Panel';
import { Select } from './components/Select';
import { TileFooter } from './components/TileFooter';

const schema = z.object({
  accountId: z.string().min(1, 'Choose an account'),
  amount: rupeesSchema(),
});
type Values = z.output<typeof schema>;

/** "12345678" -> "1234 5678" */
const spaced = (code: string) => code.replace(/(\d{4})(?=\d)/g, '$1 ');

/** One calm centred column, as for every single-task flow */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="large-title">Cash withdrawal</h1>
      {children}
    </div>
  );
}

export default function CashWithdrawalPage() {
  const accountsQuery = useAccounts();
  if (accountsQuery.isError) {
    return (
      <Shell>
        <Card>
          <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
        </Card>
      </Shell>
    );
  }
  if (accountsQuery.isPending) {
    return (
      <Shell>
        <Card className="space-y-6 p-5 sm:p-7" aria-busy="true">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-[76px] w-full rounded-2xl" />
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
            title="No active account"
            description="You need an active account to withdraw cash. Open one, or contact the bank if your account is frozen."
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
  return (
    <Shell>
      <WithdrawalFlow accounts={active} />
    </Shell>
  );
}

interface Issued {
  code: WithdrawalCode;
  account: BankAccount;
  issuedAt: number;
}

function WithdrawalFlow({ accounts }: { accounts: BankAccount[] }) {
  const { api, user } = useAuth();
  const { run } = useStepUp();
  const balanceQueries = useBalances(accounts.map((a) => a.id));
  // The code itself lives only in this component's memory: never cached, stored or sent anywhere else
  const [issued, setIssued] = useState<Issued | null>(null);
  /** After "Done": what is still valid, without the code */
  const [outstanding, setOutstanding] = useState<{ account: BankAccount; amountInPaise: string; expiresAt: string } | null>(null);
  const [problem, setProblem] = useState<{ title: string; description: string } | null>(null);
  const now = useNow(1000, Boolean(issued || outstanding));
  const form = useForm<z.input<typeof schema>, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { accountId: accounts[0]?.id ?? '', amount: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const [accountId, amountText] = form.watch(['accountId', 'amount']);
  const balance = balanceQueries[accounts.findIndex((a) => a.id === accountId)];
  const available = balance?.data?.balanceInPaise;
  const typed = parseRupees(amountText ?? '');
  const needsStepUp = Boolean(typed && comparePaise(typed, POLICY.withdrawalCodeStepUpPaise) >= 0);
  const aboveBalance = Boolean(typed && available && comparePaise(typed, available) > 0);

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    const account = accounts.find((a) => a.id === values.accountId);
    if (!account) return;
    try {
      const code = await run(() => api.ledger.createWithdrawalCode(account.id, values.amount));
      // Describe what the bank confirmed, not what was typed
      setIssued({ code, account: accounts.find((a) => a.id === code.accountId) ?? account, issuedAt: Date.now() });
      setOutstanding(null);
      form.reset({ accountId: account.id, amount: '' });
    } catch (error) {
      if (isApiError(error)) {
        if (error.requiresStepUp) {
          const threshold = formatPaise(POLICY.withdrawalCodeStepUpPaise);
          setProblem(
            user?.mfa
              ? {
                  title: 'Authenticator code needed',
                  description: `Codes of ${threshold} or more must be approved with a code from your authenticator app. Try again when you have it.`,
                }
              : {
                  title: 'Set up an authenticator first',
                  description: `Codes of ${threshold} or more must be approved with an authenticator app. Set one up in Security settings, or choose a smaller amount.`,
                }
          );
          return;
        }
        if (error.code === 'AMOUNT_TOO_LARGE') {
          form.setError('amount', { message: 'That’s more than you can withdraw in a day. Try a smaller amount.' }, { shouldFocus: true });
          return;
        }
        if (error.code === 'INVALID_AMOUNT' || error.code === 'VALIDATION_ERROR') {
          form.setError('amount', { message: error.fieldErrors.amountInPaise ?? 'Enter an amount greater than ₹0.00' }, { shouldFocus: true });
          return;
        }
      }
      setProblem(describeError(error));
    }
  });

  if (issued) {
    const remaining = new Date(issued.code.expiresAt).getTime() - now;
    if (remaining <= 0) {
      const ttl = Math.max(1, Math.round((new Date(issued.code.expiresAt).getTime() - issued.issuedAt) / 60_000));
      return (
        <Card role="status">
          <EmptyState
            icon={TimerOff}
            title="This code has expired"
            description={`For your security, codes only last ${ttl} minute${ttl === 1 ? '' : 's'}. Create a new one when you’re at the branch.`}
            className="py-16"
            action={
              <Button size="lg" onClick={() => setIssued(null)}>
                <RefreshCcw aria-hidden="true" /> Create a new code
              </Button>
            }
          />
        </Card>
      );
    }
    return (
      <CodeCard
        issued={issued}
        remaining={remaining}
        onDone={() => {
          setOutstanding({ account: issued.account, amountInPaise: issued.code.amountInPaise, expiresAt: issued.code.expiresAt });
          setIssued(null);
        }}
      />
    );
  }

  const stillValid = outstanding && new Date(outstanding.expiresAt).getTime() > now ? outstanding : null;
  const amountHint =
    aboveBalance || needsStepUp ? (
      <span className="block space-y-1">
        {aboveBalance && available ? (
          <span className="block font-medium text-warning">
            That’s more than the available balance of {formatPaise(available)}, so the branch would decline it.
          </span>
        ) : null}
        {needsStepUp ? (
          <span className="block">Codes of {formatPaise(POLICY.withdrawalCodeStepUpPaise)} or more need a code from your authenticator app.</span>
        ) : null}
      </span>
    ) : undefined;

  return (
    <>
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <div className="space-y-6 px-5 pb-7 pt-5 sm:px-7 sm:pt-7">
            <div className="space-y-1">
              <h2 className="text-title-3">Create a withdrawal code</h2>
              <p className="text-pretty text-[14px] leading-5 text-muted-foreground">
                A one-time code for the exact amount you’ll take out at any BankSphere branch.
              </p>
            </div>
            {stillValid ? (
              <Callout tone="info" title="You have an active code">
                {`A code for ${formatPaise(stillValid.amountInPaise)} from ${accountShortName(stillValid.account)} is active until ${formatTime(stillValid.expiresAt)}. Creating a new code cancels it.`}
              </Callout>
            ) : null}
            {problem ? (
              <Callout tone="danger" title={problem.title}>
                {problem.description}
              </Callout>
            ) : null}
            <Field
              label="Account"
              error={errors.accountId?.message}
              hint={available ? `Available balance: ${formatPaise(available)}` : balance?.isError ? 'Balance unavailable right now' : undefined}
            >
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
            <Field label="Amount" error={errors.amount?.message} hint={amountHint}>
              {(p) => <AmountField {...p} {...form.register('amount')} />}
            </Field>
          </div>
          <TileFooter>
            <Button type="submit" size="lg" className="w-full sm:w-auto" loading={isSubmitting}>
              <Banknote aria-hidden="true" /> Create code
            </Button>
          </TileFooter>
        </form>
      </Card>
      <Panel title="How it works">
        <ol className="space-y-3.5 pb-1">
          {[
            'Create a code here for the exact amount you need.',
            `Go to any BankSphere branch within ${POLICY.withdrawalCodeTtlMinutes} minutes.`,
            'Give the teller the code and show your photo ID. The code works only once.',
          ].map((text, i) => (
            <li key={text} className="flex gap-3.5 text-[14px] leading-5">
              <span className="w-3 shrink-0 text-[15px] font-semibold leading-5 text-muted-foreground tnum" aria-hidden="true">
                {i + 1}
              </span>
              <span className="text-pretty text-foreground/80">{text}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}

/** The code as a pass: one glanceable figure, its countdown, and a stub saying what it is good for */
function CodeCard({ issued, remaining, onDone }: { issued: Issued; remaining: number; onDone: () => void }) {
  const headingId = useId();
  const { code, account } = issued;
  const total = Math.max(1, new Date(code.expiresAt).getTime() - issued.issuedAt);
  const left = Math.min(100, Math.max(0, (remaining / total) * 100));
  const ending = remaining < 2 * 60_000;
  const amount = formatPaise(code.amountInPaise);
  const guidance = [
    { icon: IdCard, text: 'Show it to the teller together with your photo ID at any BankSphere branch.' },
    { icon: BadgeCheck, text: `It works once, for exactly ${amount} from ${accountShortName(account)}.` },
    { icon: RefreshCcw, text: 'Creating a new code cancels this one.' },
    { icon: PhoneOff, text: 'BankSphere will never ask for this code by phone, SMS or email. Only the teller at the counter needs it.' },
  ];
  return (
    <Card role="region" aria-labelledby={headingId} className="overflow-hidden">
      <div className="px-5 pt-7 text-center sm:px-8 sm:pt-9">
        <h2 id={headingId} className="text-title-3">
          Your withdrawal code
        </h2>
        <p className="mx-auto mt-1 max-w-sm text-pretty text-[14px] leading-5 text-muted-foreground">
          We show it only once. Note it down, or keep this screen open at the branch.
        </p>
      </div>

      <div className="px-5 pb-8 pt-7 text-center sm:px-8 sm:pt-9">
        {/* Offset by the copy button's width, so the code itself sits on the centre line */}
        <div className="flex items-center justify-center gap-1.5 pl-10 sm:gap-2 sm:pl-11">
          <p aria-hidden="true" className="select-all whitespace-nowrap text-[46px] font-semibold leading-none tracking-[0.04em] tnum sm:text-[64px]">
            {spaced(code.authorizationCode)}
          </p>
          <CopyButton value={code.authorizationCode} label="Copy code" className="relative size-10 shrink-0 after:absolute after:-inset-0.5 [&_svg]:size-[18px]" />
        </div>
        <p className="sr-only">Your code is {code.authorizationCode.split('').join(' ')}</p>
        <div className="mx-auto mt-7 max-w-[15rem]">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className={cn('h-full rounded-full transition-[width] duration-1000 ease-linear', ending ? 'bg-warning' : 'bg-primary')}
              style={{ width: `${left}%` }}
            />
          </div>
          <p className={cn('mt-2.5 text-[14px] font-medium tnum', ending ? 'text-warning' : 'text-muted-foreground')}>
            <span aria-hidden="true">Expires in {formatClock(remaining)}</span>
            <span className="sr-only">Expires at {formatTime(code.expiresAt)}</span>
          </p>
        </div>
      </div>

      {/* The tear line of a ticket: notches cut into the tile's edges and a dashed rule between them */}
      <div aria-hidden="true" className="relative h-0">
        <span className="absolute -left-3 -top-3 size-6 rounded-full bg-canvas" />
        <span className="absolute -right-3 -top-3 size-6 rounded-full bg-canvas" />
        <span className="absolute inset-x-6 top-0 border-t-2 border-dashed border-border" />
      </div>

      <dl className="grid grid-cols-3 divide-x divide-border/70 py-6 text-center">
        <StubFact label="Amount" value={amount} />
        <StubFact label="From" value={accountShortName(account)} />
        <StubFact label="Valid until" value={formatTime(code.expiresAt)} />
      </dl>

      <div className="space-y-4 border-t border-border/70 px-5 py-6 sm:px-8">
        <ul className="space-y-3">
          {guidance.map(({ icon: Icon, text }) => (
            <li key={text} className="flex gap-3 text-[14px] leading-5">
              <Icon className="mt-px size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
              <span className="text-pretty text-foreground/85">{text}</span>
            </li>
          ))}
        </ul>
        <p className="flex gap-3 text-[13px] leading-[18px] text-muted-foreground">
          <MailCheck className="mt-px size-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
          We’ve also emailed you to say a code was created. The email doesn’t contain the code.
        </p>
      </div>

      <TileFooter sticky={false}>
        <Button size="lg" className="w-full sm:w-auto sm:min-w-[8rem]" onClick={onDone}>
          Done
        </Button>
      </TileFooter>
    </Card>
  );
}

function StubFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2 sm:px-4">
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-balance text-[15px] font-semibold tracking-[-0.01em] tnum">{value}</dd>
    </div>
  );
}
