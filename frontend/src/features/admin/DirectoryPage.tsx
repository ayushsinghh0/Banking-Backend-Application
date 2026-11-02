import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MonitorSmartphone, Search, UserPlus, Users } from 'lucide-react';
import { useApi, useUser } from '@/lib/auth/AuthProvider';
import { ROLES, type Role } from '@/lib/auth/session';
import type { DirectoryUser } from '@/lib/api/types';
import { qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { DataTable, Pagination, type Column } from '@/components/ui/data';
import { Input, NativeSelect } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/overlays';
import { Avatar, Badge, Card, PageHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { formatDate } from './components/format';
import { RequestStaffDialog } from './components/RequestStaffDialog';
import { ROLE_INFO, STAFF_ROLES, roleLabel } from './components/roles';
import { useDebouncedValue } from './components/useDebouncedValue';
import { UserActionDialog, UserActionsMenu, type UserAction } from './components/UserActions';
import { UserSessionsSheet } from './components/UserSessionsSheet';

const PAGE_SIZE = 20;

const ROLE_FILTERS: Array<{ value: Role | ''; label: string }> = [
  { value: '', label: 'All roles' },
  { value: 'CUSTOMER', label: 'Customers' },
  ...STAFF_ROLES.map((role) => ({ value: role, label: ROLE_INFO[role].label })),
];

const parseRole = (value: string | null): Role | '' => (ROLES as readonly string[]).includes(value ?? '') ? (value as Role) : '';

export default function DirectoryPage() {
  const api = useApi();
  const me = useUser();
  const canManage = me.role === 'BANK_ADMIN';
  const searchId = useId();
  const roleId = useId();
  const [params, setParams] = useSearchParams();
  const role = parseRole(params.get('role'));
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const debounced = useDebouncedValue(search.trim(), 300);
  // Clearing the box applies at once; typing waits for a pause
  const q = search.trim() === '' ? '' : debounced;

  // Filters live in the address, so they survive opening a customer and coming back
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    setParams(next, { replace: true });
  }, [q, params, setParams]);

  const filterKey = `${role}|${q}`;
  const [page, setPage] = useState({ filterKey, offset: 0 });
  const offset = page.filterKey === filterKey ? page.offset : 0;

  const filters = { role: role || undefined, q: q || undefined };
  const query = useQuery({
    queryKey: qk.directory({ ...filters, offset, limit: PAGE_SIZE }),
    queryFn: () => api.admin.users({ ...filters, limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });

  const [sessionsFor, setSessionsFor] = useState<DirectoryUser | null>(null);
  const [action, setAction] = useState<UserAction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  const setRole = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('role', value);
    else next.delete('role');
    setParams(next, { replace: true });
  };
  const filtered = Boolean(role || q);
  const clearFilters = () => {
    setSearch('');
    setParams({}, { replace: true });
  };

  const columns: Column<DirectoryUser>[] = [
    {
      key: 'user',
      header: 'User',
      cell: (user) => <UserCell user={user} isMe={user.id === me.id} />,
    },
    // Secondary columns appear as the screen widens; until then UserCell says what matters under the email
    { key: 'role', header: 'Role', hideOnMobile: true, className: 'whitespace-nowrap', cell: (user) => roleLabel(user.role) },
    { key: 'status', header: 'Status', hideOnMobile: true, cell: (user) => <ActiveStatus user={user} /> },
    {
      key: 'mfa',
      header: 'Two-factor',
      hideOnMobile: true,
      cell: (user) => <span className={user.mfaEnabled ? 'text-muted-foreground' : 'font-medium'}>{user.mfaEnabled ? 'On' : 'Off'}</span>,
    },
    {
      key: 'verified',
      header: 'Email',
      hideOnMobile: true,
      className: 'whitespace-nowrap md:hidden xl:table-cell',
      cell: (user) =>
        user.isEmailVerified ? <span className="text-muted-foreground">Verified</span> : <span className="font-medium">Not verified</span>,
    },
    {
      key: 'created',
      header: 'Created',
      hideOnMobile: true,
      className: 'whitespace-nowrap md:hidden xl:table-cell',
      cell: (user) => (
        <time dateTime={user.createdAt} className="text-muted-foreground tnum">
          {formatDate(user.createdAt)}
        </time>
      ),
    },
  ];
  if (canManage) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'w-14 max-md:pl-0',
      cell: (user) =>
        user.id === me.id ? (
          <span className="sr-only">No actions on your own account</span>
        ) : (
          <UserActionsMenu
            user={user}
            onAction={(next) => {
              setAction(next);
              setActionOpen(true);
            }}
            onSessions={setSessionsFor}
          />
        ),
    });
  } else {
    // Read-only: support can still see where someone is signed in
    columns.push({
      key: 'sessions',
      header: <span className="sr-only">Sessions</span>,
      align: 'right',
      className: 'w-14 max-md:pl-0',
      cell: (user) => (
        <Tooltip content="Sessions and devices">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground max-md:size-11"
            aria-label={`Sessions and devices for ${user.email}`}
            onClick={() => setSessionsFor(user)}
          >
            <MonitorSmartphone aria-hidden="true" />
          </Button>
        </Tooltip>
      ),
    });
  }

  const rows = query.data;
  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader
        title={canManage ? 'Staff & users' : 'User directory'}
        description={
          canManage
            ? 'Everyone with a BankSphere sign-in. Customer sign-in changes apply at once; staff changes and authenticator resets need a second administrator.'
            : 'Everyone with a BankSphere sign-in. This view is read-only; bank administrators make changes.'
        }
        actions={
          canManage ? (
            <Button variant="secondary" onClick={() => setRequestOpen(true)}>
              <UserPlus aria-hidden="true" /> Request new staff member
            </Button>
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-2 border-b border-border/70 p-4 sm:flex-row sm:p-5">
          <div className="relative min-w-0 flex-1">
            <label htmlFor={searchId} className="sr-only">
              Search
            </label>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={searchId}
              type="search"
              className="border-transparent bg-muted pl-10 hover:border-transparent focus-visible:bg-background"
              placeholder="Email address or user ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="sm:w-52">
            <label htmlFor={roleId} className="sr-only">
              Role
            </label>
            <NativeSelect
              id={roleId}
              className="border-transparent bg-muted hover:border-transparent focus-visible:bg-background"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLE_FILTERS.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {query.isPending ? (
          <p role="status" className="sr-only">
            Loading users
          </p>
        ) : null}
        <div aria-busy={query.isFetching} className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')}>
          <DataTable
            caption="Users"
            // A row list on phones: the one visible column needs no header
            className="max-md:[&_thead]:hidden"
            columns={columns}
            rows={rows}
            getRowKey={(user) => user.id}
            loading={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
            empty={
              filtered
                ? {
                    icon: Search,
                    title: 'No one matches these filters',
                    description: 'Try another role, or search for a full email address or user ID.',
                    action: (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ),
                  }
                : { icon: Users, title: 'No users found' }
            }
          />
        </div>
        {rows && (rows.length > 0 || offset > 0) ? (
          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            count={rows.length}
            onChange={(next) => setPage({ filterKey, offset: next })}
          />
        ) : null}
      </Card>
      {sessionsFor ? <UserSessionsSheet user={sessionsFor} canRevoke={canManage} onClose={() => setSessionsFor(null)} /> : null}
      {canManage ? (
        <>
          <UserActionDialog action={action} open={actionOpen} onOpenChange={setActionOpen} />
          <RequestStaffDialog open={requestOpen} onOpenChange={setRequestOpen} />
        </>
      ) : null}
    </div>
  );
}

/** Active is the normal state and stays quiet; a disabled sign-in is the exception worth a badge */
function ActiveStatus({ user }: { user: DirectoryUser }) {
  return user.isActive ? (
    <span className="text-muted-foreground">Active</span>
  ) : (
    <Badge tone="danger" dot>
      Disabled
    </Badge>
  );
}

function UserCell({ user, isMe }: { user: DirectoryUser; isMe: boolean }) {
  // Phones show no detail columns: say the role, and only the states that are out of the ordinary
  const exceptions = [
    !user.isActive && { text: 'Disabled', className: 'font-medium text-destructive' },
    !user.mfaEnabled && { text: 'Two-factor off' },
    !user.isEmailVerified && { text: 'Email not verified' },
  ].filter((x): x is { text: string; className?: string } => Boolean(x));
  return (
    // Phones: as wide as the screen allows beside the actions menu, so long addresses truncate instead of scrolling
    <div className="flex min-w-0 items-center gap-3 max-md:max-w-[calc(100vw-8.5rem)]">
      <Avatar name={user.email} className="size-9 text-[13px]" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {user.role === 'CUSTOMER' ? (
            <Link
              to={`/customers/${encodeURIComponent(user.id)}`}
              className="min-w-0 truncate font-medium tracking-[-0.01em] text-primary underline-offset-2 hover:underline"
              title={user.email}
            >
              {user.email}
            </Link>
          ) : (
            <span className="min-w-0 truncate font-medium tracking-[-0.01em]" title={user.email}>
              {user.email}
            </span>
          )}
          {isMe ? (
            <Badge tone="neutral" className="shrink-0">
              You
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground md:hidden">
          <span>{roleLabel(user.role)}</span>
          {exceptions.map((item) => (
            <span key={item.text} className="flex gap-x-1.5">
              <span aria-hidden="true">·</span>
              <span className={item.className}>{item.text}</span>
            </span>
          ))}
        </p>
        {/* Between md and xl the email column is hidden: keep its exception visible */}
        {user.isEmailVerified ? null : (
          <p className="mt-0.5 hidden text-[13px] leading-[18px] text-muted-foreground md:block xl:hidden">Email not verified</p>
        )}
      </div>
    </div>
  );
}
