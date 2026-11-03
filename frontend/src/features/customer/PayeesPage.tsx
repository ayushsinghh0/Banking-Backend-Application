import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, Gauge, PhoneOff, Trash2, UserPlus, Users } from 'lucide-react';
import type { Beneficiary } from '@/lib/api/types';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { formatPaise } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';
import { maskAccountNumber } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Avatar, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { useBeneficiaries, useNow } from './hooks';
import { POLICY, formatDate, formatDateTime, formatWait, isNotFound } from './lib';
import { AddPayeeDialog } from './components/AddPayeeDialog';
import { Panel } from './components/Panel';

export default function PayeesPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const payeesQuery = useBeneficiaries();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(() => params.get('add') === '1');
  const [removing, setRemoving] = useState<Beneficiary | null>(null);
  const hasCooling = (payeesQuery.data ?? []).some((p) => new Date(p.activatesAt).getTime() > Date.now());
  // Tick while a payee is cooling off so its countdown (and "Pay") update by themselves
  const ticked = useNow(15_000, hasCooling);
  // A re-render (e.g. after adding a payee) must never compare against a stale clock
  const now = Math.max(ticked, Date.now());

  const setAddOpen = (open: boolean) => {
    setAdding(open);
    if (!open && params.has('add')) {
      const next = new URLSearchParams(params);
      next.delete('add');
      setParams(next, { replace: true });
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.ledger.removeBeneficiary(removing.id);
      notifySuccess(`${removing.nickname} removed`, 'You can add them again at any time.');
    } catch (error) {
      if (!isNotFound(error)) {
        notifyError(error, 'The payee could not be removed');
        throw error;
      }
      // Already gone (removed in another tab): the list just needs refreshing
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.beneficiaries });
    }
  };

  const payees = payeesQuery.data;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="large-title">Payees</h1>
        <Button onClick={() => setAddOpen(true)}>
          <UserPlus aria-hidden="true" /> Add payee
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start lg:gap-6">
        <Card className="overflow-hidden lg:col-span-8">
          {payeesQuery.error && !payees?.length ? (
            <ErrorState error={payeesQuery.error} onRetry={() => void payeesQuery.refetch()} />
          ) : !payees ? (
            <PayeesSkeleton />
          ) : payees.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No payees yet"
              description="Add someone’s account to send them money. Your own accounts don’t need to be added."
              action={
                <Button variant="secondary" onClick={() => setAddOpen(true)}>
                  <UserPlus aria-hidden="true" /> Add payee
                </Button>
              }
            />
          ) : (
            <ul aria-label="Your payees" className="divide-y divide-border/70 py-1">
              {payees.map((payee) => (
                <PayeeRow key={payee.id} payee={payee} now={now} onRemove={() => setRemoving(payee)} />
              ))}
            </ul>
          )}
        </Card>

        <Panel title="Keeping payments safe" className="lg:col-span-4">
          <ul className="space-y-4 pb-1 text-[14px] leading-5">
            <SafetyNote icon={Clock}>
              New payees become active after a {POLICY.payeeCoolingMinutes}-minute cooling-off period, unless you approve them instantly with your
              authenticator.
            </SafetyNote>
            <SafetyNote icon={Gauge}>
              In their first 24 hours, you can send each new payee up to {formatPaise(POLICY.newPayeeLimitPaise)} in total.
            </SafetyNote>
            <SafetyNote icon={PhoneOff}>We’ll never ask you to add a payee over the phone. If someone does, it’s a scam.</SafetyNote>
          </ul>
        </Panel>
      </div>

      <AddPayeeDialog open={adding} onOpenChange={setAddOpen} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        tone="destructive"
        title={`Remove ${removing?.nickname ?? 'payee'}?`}
        description={
          removing
            ? `You won’t be able to send money to ${maskAccountNumber(removing.accountNumber)} until you add them again. Adding them again restarts the cooling-off period.`
            : undefined
        }
        confirmLabel="Remove payee"
        onConfirm={remove}
      />
    </div>
  );
}

/** Contact-style row: monogram, name, account and readiness, then Pay and Remove */
function PayeeRow({ payee, now, onRemove }: { payee: Beneficiary; now: number; onRemove: () => void }) {
  const wait = new Date(payee.activatesAt).getTime() - now;
  const ready = wait <= 0;
  return (
    <li className="flex items-center gap-3.5 px-5 py-3 sm:px-6">
      <Avatar name={payee.nickname} className="size-10 text-[14px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{payee.nickname}</p>
        {/* Phones: number, then the countdown on its own line. Wider screens: one line, with when it was added. */}
        <p className="min-w-0 text-[13px] text-muted-foreground sm:flex sm:items-center sm:gap-1.5">
          <span className="tnum">{maskAccountNumber(payee.accountNumber)}</span>
          <span aria-hidden="true" className="hidden sm:inline">
            ·
          </span>
          {ready ? (
            <span className="hidden truncate sm:inline">Added {formatDate(payee.createdAt)}</span>
          ) : (
            <span
              className="flex items-center gap-1 whitespace-nowrap font-medium text-warning"
              title={`Active from ${formatDateTime(payee.activatesAt)}`}
            >
              <Clock className="size-3.5 shrink-0" aria-hidden="true" /> Activates in {formatWait(wait)}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {ready ? (
          <Button asChild variant="secondary" className="h-10 px-4">
            <Link to={`/transfer?payee=${encodeURIComponent(payee.id)}`} aria-label={`Pay ${payee.nickname}`}>
              Pay
            </Link>
          </Button>
        ) : (
          <Button variant="secondary" className="h-10 px-4" disabled aria-label={`Pay ${payee.nickname}`}>
            Pay
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${payee.nickname}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

function SafetyNote({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
      <p className="text-pretty text-foreground/80">{children}</p>
    </li>
  );
}

function PayeesSkeleton() {
  return (
    <div className="space-y-5 px-5 py-5 sm:px-6" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3.5">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-9 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
