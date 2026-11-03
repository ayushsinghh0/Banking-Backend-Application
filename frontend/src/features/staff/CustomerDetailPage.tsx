import { Link, useLocation, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { UserX } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import type { Role } from '@/lib/auth/session';
import { qk } from '@/lib/query';
import { UUID_PATTERN } from '@/lib/validation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/primitives';
import { UserSessionsPanel } from '@/features/ops/UserSessionsPanel';
import { AccountsSection } from './components/AccountsSection';
import type { BackLink } from './components/CustomerTable';
import { LoadingAnnouncement } from './components/LoadingAnnouncement';
import { KycDecisionPanel } from './components/KycDecisionPanel';
import { KycHistoryCard } from './components/KycHistoryCard';
import { ProfileHeader, type ProfileState } from './components/ProfileCard';
import { SignInAccessCard, useDirectoryUser } from './components/SignInAccessCard';
import { shortId } from './components/format';
import { isNotFound } from './components/hooks';
import { BackLink as BackLinkView } from './components/layout';

const HISTORY_ROLES: Role[] = ['KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'];
const ACCESS_ROLES: Role[] = ['BANK_ADMIN', 'SUPPORT'];
const SEARCH_ROLES: Role[] = ['KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'];

/** Where "back" goes: the list the person came from, else their own customer list */
function backLinkFor(state: unknown, role: Role): BackLink | null {
  const candidate = state as Partial<BackLink> | null;
  if (typeof candidate?.from === 'string' && candidate.from.startsWith('/') && !candidate.from.startsWith('//')) {
    return { from: candidate.from, fromLabel: typeof candidate.fromLabel === 'string' ? candidate.fromLabel : 'Back' };
  }
  if (role === 'KYC_OFFICER') return { from: '/kyc', fromLabel: 'KYC review' };
  if (SEARCH_ROLES.includes(role)) return { from: '/customers', fromLabel: 'Customers' };
  return null;
}

function NotFound({ role, back }: { role: Role; back: BackLink | null }) {
  return (
    <div className="space-y-6 lg:space-y-8">
      {back ? <BackLinkView to={back.from} label={back.fromLabel} /> : null}
      <PageHeader title="Customer not found" />
      <Card>
        <EmptyState
          icon={UserX}
          title="No customer matches this ID"
          description="Check the ID, or search for the customer by name or phone number."
          action={
            SEARCH_ROLES.includes(role) ? (
              <Button asChild variant="secondary">
                <Link to="/customers">Search customers</Link>
              </Button>
            ) : null
          }
        />
      </Card>
    </div>
  );
}

/**
 * Customer 360. The profile is the header tile; the person's own tools (a KYC decision, sign-in controls)
 * sit beside it with the KYC history, and the accounts take the main column. On phones the tiles stack in
 * that order: who, what to decide, then the accounts.
 */
export default function CustomerDetailPage() {
  const { userId = '' } = useParams();
  const api = useApi();
  const user = useUser();
  const location = useLocation();
  const valid = UUID_PATTERN.test(userId);
  const canSeeHistory = HISTORY_ROLES.includes(user.role);
  const canSeeAccess = ACCESS_ROLES.includes(user.role);
  const isAdmin = user.role === 'BANK_ADMIN';
  const back = backLinkFor(location.state, user.role);

  const profileQuery = useQuery({ queryKey: qk.customer(userId), queryFn: () => api.customers.get(userId), enabled: valid });
  const accountsQuery = useQuery({ queryKey: qk.customerAccounts(userId), queryFn: () => api.accounts.list(userId), enabled: valid });
  const directoryQuery = useDirectoryUser(userId, valid && canSeeAccess);

  if (!valid) return <NotFound role={user.role} back={back} />;

  const profile = profileQuery.data;
  const profileMissing = isNotFound(profileQuery.error);
  const directoryUser = directoryQuery.data ?? null;
  const directorySettled = !canSeeAccess || !directoryQuery.isPending;
  // A customer without a profile still exists if they have accounts or a sign-in account
  const notFound =
    profileMissing && accountsQuery.isSuccess && accountsQuery.data.length === 0 && directorySettled && directoryUser === null;
  const checkingMissing = profileMissing && (accountsQuery.isPending || !directorySettled);

  if (notFound) return <NotFound role={user.role} back={back} />;

  const name = profile?.fullName ?? directoryUser?.email ?? 'this customer';
  const loading = profileQuery.isPending || checkingMissing;
  const state: ProfileState = profile
    ? { kind: 'ready', profile }
    : loading
      ? { kind: 'loading' }
      : profileMissing
        ? { kind: 'missing' }
        : { kind: 'error', error: profileQuery.error, onRetry: () => void profileQuery.refetch() };

  const decides = user.role === 'KYC_OFFICER' && profile;
  const showHistory = canSeeHistory && !profileMissing;
  const side = decides || canSeeAccess || showHistory;

  return (
    <div className="space-y-6 lg:space-y-8">
      {back ? <BackLinkView to={back.from} label={back.fromLabel} /> : null}
      <LoadingAnnouncement active={loading} label="Loading customer…" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        <ProfileHeader
          userId={userId}
          title={profile?.fullName ?? (loading ? <Skeleton className="h-8 w-56" /> : (directoryUser?.email ?? `Customer ${shortId(userId)}`))}
          state={state}
          className={cn('min-w-0', side ? 'lg:col-span-8' : 'lg:col-span-12')}
        />
        {side ? (
          <div className="min-w-0 space-y-5 lg:col-span-4 lg:row-span-2 lg:space-y-6 lg:self-start">
            {decides ? <KycDecisionPanel profile={decides} me={user.id} /> : null}
            {canSeeAccess ? <SignInAccessCard userId={userId} name={name} query={directoryQuery} canManage={isAdmin} me={user.id} /> : null}
            {canSeeAccess ? <UserSessionsPanel userId={userId} name={name} canRevoke={isAdmin && userId !== user.id} /> : null}
            {showHistory ? <KycHistoryCard userId={userId} me={user.id} /> : null}
          </div>
        ) : null}
        <AccountsSection
          customerId={userId}
          query={accountsQuery}
          canAdminister={isAdmin}
          me={user.id}
          className={cn('min-w-0', side ? 'lg:col-span-8' : 'lg:col-span-12')}
        />
      </div>
    </div>
  );
}
