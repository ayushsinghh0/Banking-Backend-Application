import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Eye, UserSearch } from 'lucide-react';
import { useApi } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import type { KycStatus } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pagination } from '@/components/ui/data';
import { NativeSelect } from '@/components/ui/input';
import { CustomerTable } from './components/CustomerTable';
import { LoadingAnnouncement } from './components/LoadingAnnouncement';
import { SearchField } from './components/SearchField';
import { useListParams, useSearchParam } from './components/hooks';
import { KYC_LABEL } from './components/format';

const LIMIT = 20;
const KYC_OPTIONS: KycStatus[] = ['PENDING', 'VERIFIED', 'REJECTED'];

export default function CustomersPage() {
  const api = useApi();
  const selectId = useId();
  const { params, update, offset } = useListParams();
  const { search, setSearch, q } = useSearchParam(params, update);
  const kyc = KYC_OPTIONS.find((s) => s === params.get('kyc'));

  // Customer data is only fetched for a deliberate search or filter, never listed by default
  const active = Boolean(q || kyc);
  const filters = { kycStatus: kyc, q, limit: LIMIT, offset };
  const query = useQuery({
    queryKey: qk.customers(filters),
    queryFn: () => api.customers.list({ ...filters, q: q || undefined }),
    enabled: active,
    // Keep rows on screen while a search is refined or paged, never across different KYC filters
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[2] as { kycStatus?: KycStatus } | undefined)?.kycStatus === kyc ? previous : undefined,
  });
  const rows = active ? query.data : undefined;

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title="Customers" />
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <SearchField
            label="Search"
            hint="Name, phone number or user ID"
            placeholder="Name, phone number or user ID"
            value={search}
            onChange={setSearch}
            size="lg"
            className="flex-1"
          />
          <div className="relative sm:w-48">
            <label htmlFor={selectId} className="sr-only">
              KYC status
            </label>
            {/* Drawn here: the shared select's background chevron doesn't render (see the redesign notes) */}
            <ChevronDown className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2.25} aria-hidden="true" />
            <NativeSelect
              id={selectId}
              value={kyc ?? ''}
              onChange={(e) => update({ kyc: e.target.value, offset: undefined })}
              // The card colour is set as a raw property: a bg-* colour class would make class merging drop the chevron's position
              className={cn(
                'h-12 rounded-full border-0 pl-5 shadow-card [background-color:hsl(var(--card))] hover:shadow-raised sm:text-[15px]',
                !kyc && 'text-muted-foreground'
              )}
            >
              <option value="">Any KYC status</option>
              {KYC_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {KYC_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <p className="flex items-center gap-1.5 px-1 text-[13px] text-muted-foreground">
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          Opening a customer record is logged with your name and role.
        </p>
      </div>
      {active ? (
        <Card className="overflow-hidden">
          <LoadingAnnouncement active={query.isFetching} label="Loading customers…" />
          <CustomerTable
            rows={rows}
            loading={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
            caption="Customer search results"
            showWaiting={kyc === 'PENDING'}
            showStatus={!kyc}
            dateLabel="Last updated"
            backLabel="Customers"
            empty={
              q
                ? { title: `No customers match “${q}”`, description: 'Check the spelling, or try a phone number or user ID.' }
                : { title: `No customers with KYC ${KYC_LABEL[kyc ?? 'PENDING'].toLowerCase()}` }
            }
          />
          {rows && (rows.length > 0 || offset > 0) ? (
            <Pagination offset={offset} limit={LIMIT} count={rows.length} onChange={(next) => update({ offset: next })} />
          ) : null}
        </Card>
      ) : (
        <EmptyState
          icon={UserSearch}
          title="Search for a customer"
          description="Enter a name, phone number or user ID, or choose a KYC status to list customers."
          className="py-16"
        />
      )}
    </div>
  );
}
