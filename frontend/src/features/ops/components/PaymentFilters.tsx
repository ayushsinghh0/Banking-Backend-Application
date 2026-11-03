import { useCallback, useId, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { TOP_UP_STATUSES, type TopUpFilters, type TopUpStatus } from '../api';
import { topUpStatusLabel } from '../format';
import { useIdFilter } from './useIdFilter';

/** Quiet grey fields inside the list tile, as on the directory */
const quiet = 'border-transparent bg-muted hover:border-transparent focus-visible:bg-background';

export type FilterChange = Partial<Record<keyof TopUpFilters, string | undefined>>;

/**
 * Status, customer and a date range. The status and dates apply as they change; the customer ID once it is a
 * whole ID (a partial one would match nothing). On phones the fields fold away behind a "Filters" button so
 * the list comes first; they start open when a filter is already set. Remount with a new key to clear the
 * typed customer ID.
 */
export function PaymentFilters({
  values,
  rangeError,
  onChange,
}: {
  /** As written in the address (dates possibly out of order) */
  values: { status?: TopUpStatus; customerId?: string; from?: string; to?: string };
  rangeError: boolean;
  onChange: (change: FilterChange) => void;
}) {
  const panelId = useId();
  const applyCustomer = useCallback((customerId: string | undefined) => onChange({ customerId }), [onChange]);
  const customer = useIdFilter(values.customerId ?? '', applyCustomer);
  const active = [values.status, values.customerId, values.from, values.to].filter(Boolean).length;
  const [open, setOpen] = useState(active > 0);

  return (
    <div className="border-b border-border/70">
      <div className="px-4 pt-4 md:hidden">
        <Button variant="secondary" size="sm" className="h-10" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal aria-hidden="true" />
          {active ? `Filters (${active})` : 'Filters'}
        </Button>
      </div>
      <div
        id={panelId}
        className={cn(
          'grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 md:p-5 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,10.5rem)_minmax(0,10.5rem)]',
          !open && 'max-md:hidden'
        )}
      >
        <Field label="Status" className="min-w-0">
          {(p) => (
            <NativeSelect {...p} className={quiet} value={values.status ?? ''} onChange={(e) => onChange({ status: e.target.value || undefined })}>
              <option value="">All statuses</option>
              {TOP_UP_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {topUpStatusLabel(status)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Customer ID" className="min-w-0" error={customer.invalid ? 'Enter the full customer ID' : undefined}>
          {(p) => (
            <Input
              {...p}
              className={quiet}
              value={customer.text}
              onChange={(e) => customer.setText(e.target.value)}
              placeholder="From the customer’s profile"
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
            />
          )}
        </Field>
        <Field label="From" className="min-w-0">
          {(p) => (
            <Input {...p} type="date" className={quiet} value={values.from ?? ''} max={values.to} onChange={(e) => onChange({ from: e.target.value || undefined })} />
          )}
        </Field>
        <Field label="To" className="min-w-0" error={rangeError ? 'Choose a date on or after the start date' : undefined}>
          {(p) => (
            <Input {...p} type="date" className={quiet} value={values.to ?? ''} min={values.from} onChange={(e) => onChange({ to: e.target.value || undefined })} />
          )}
        </Field>
      </div>
    </div>
  );
}
