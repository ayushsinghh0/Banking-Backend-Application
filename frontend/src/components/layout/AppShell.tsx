import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronRight, ChevronsUpDown, Ellipsis, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth, useUser } from '@/lib/auth/AuthProvider';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';
import { ACCOUNT_LINKS, HOME, NAVIGATION, ROLE_LABEL, type NavItem, type NavSection } from '@/app/navigation';
import { Avatar } from '@/components/ui/primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SheetContent,
  Tooltip,
} from '@/components/ui/overlays';
import { Button } from '@/components/ui/button';
import { RealtimeProvider } from '@/lib/realtime';
import { SphereLauncher, SphereProvider } from '@/features/assistant/Sphere';
import { BrandLogo } from './Brand';
import { ConnectionIndicator } from './ConnectionIndicator';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Cycles light → dark → system (used where there is no account menu, e.g. sign-in pages) */
export function ThemeToggle() {
  const { preference, resolved, setTheme } = useTheme();
  const next = THEME_OPTIONS[(THEME_OPTIONS.findIndex((o) => o.value === preference) + 1) % THEME_OPTIONS.length]!;
  const Icon = resolved === 'dark' ? Moon : Sun;
  return (
    <Tooltip content={`Theme: ${preference} (switch to ${next.label.toLowerCase()})`}>
      <Button variant="ghost" size="icon" aria-label={`Switch to ${next.label.toLowerCase()} theme`} onClick={() => setTheme(next.value)}>
        <Icon aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/** The routes `/teller` and `/teller/operations` share a prefix: only the exact one is current */
const exact = (item: NavItem) => item.to === '/teller';

// --- Account menu -----------------------------------------------------------------------------

function UserMenu({ variant }: { variant: 'avatar' | 'sidebar' }) {
  const user = useUser();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { preference, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'avatar' ? (
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full transition-[box-shadow] hover:shadow-[0_0_0_4px_hsl(var(--foreground)/0.06)] focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            aria-label="Account menu"
          >
            <Avatar name={user.email} />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            aria-label="Account menu"
          >
            <Avatar name={user.email} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium tracking-[-0.01em]">{user.email}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{ROLE_LABEL[user.role]}</span>
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={variant === 'sidebar' ? 'top' : 'bottom'} sideOffset={8} className="w-64">
        <DropdownMenuLabel>
          <span className="block truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{user.email}</span>
          <span className="block">{ROLE_LABEL[user.role]}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ACCOUNT_LINKS[user.role].map((link) => (
          <DropdownMenuItem key={link.to} onSelect={() => navigate(link.to)}>
            <link.icon aria-hidden="true" /> {link.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(value) => setTheme(value as ThemePreference)}>
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon aria-hidden="true" /> {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={async () => {
            await signOut();
            navigate('/login', { replace: true, state: { signedOut: true } });
          }}
        >
          <LogOut aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Desktop: top bar (customers) -------------------------------------------------------------

function TopNav({ items }: { items: NavItem[] }) {
  return (
    <nav aria-label="Main" className="flex items-center gap-0.5">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={exact(item)}
          className={({ isActive }) =>
            cn(
              'inline-flex h-9 items-center rounded-full px-4 text-[14px] font-medium tracking-[-0.01em] transition-colors duration-200',
              isActive ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:text-foreground'
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

// --- Desktop: sidebar (staff) -----------------------------------------------------------------

function SidebarNav({ sections }: { sections: NavSection[] }) {
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
      {sections.map((section, index) => (
        <div key={section.title ?? index} className="mt-6 first:mt-2">
          {section.title ? <p className="px-3 pb-1.5 text-[12px] font-semibold text-muted-foreground">{section.title}</p> : null}
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={exact(item)}
                  className={({ isActive }) =>
                    cn(
                      'group flex h-9 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium tracking-[-0.01em] transition-colors duration-150',
                      isActive ? 'bg-card text-foreground shadow-card' : 'text-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground'
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={cn('size-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')}
                        strokeWidth={isActive ? 2 : 1.75}
                        aria-hidden="true"
                      />
                      {item.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// --- Phones and tablets: tab bar --------------------------------------------------------------

const MAX_TABS = 5;

function TabBar({ sections }: { sections: NavSection[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const all = sections.flatMap((s) => s.items);
  const tabs = all.length <= MAX_TABS ? all : all.slice(0, MAX_TABS - 1);
  const overflow = all.length > MAX_TABS ? all.slice(MAX_TABS - 1) : [];
  const moreActive = overflow.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const tabClass = (active: boolean) =>
    cn(
      'flex min-h-[54px] w-full flex-col items-center justify-center gap-[3px] pt-1.5 text-[10.5px] font-medium tracking-[0.01em] transition-colors duration-150 active:opacity-60 cursor-pointer',
      active ? 'text-primary' : 'text-muted-foreground'
    );
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/80 pb-safe backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/70"
    >
      <ul className="mx-auto flex max-w-xl px-2">
        {tabs.map((item) => (
          <li key={item.to} className="flex flex-1">
            <NavLink to={item.to} end={exact(item)} aria-label={item.short ? item.label : undefined} className={({ isActive }) => tabClass(isActive)}>
              {({ isActive }) => (
                <>
                  <item.icon className="size-[23px]" strokeWidth={isActive ? 2.1 : 1.7} aria-hidden="true" />
                  <span>{item.short ?? item.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
        {overflow.length ? (
          <li className="flex flex-1">
            <button type="button" className={tabClass(moreActive)} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
              <Ellipsis className="size-[23px]" strokeWidth={moreActive ? 2.1 : 1.7} aria-hidden="true" />
              <span>More</span>
            </button>
          </li>
        ) : null}
      </ul>
      {overflow.length ? (
        <DialogPrimitive.Root open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetContent side="bottom" title="All sections" className="bg-canvas">
            <div className="overflow-y-auto px-4 pb-6 pt-2">
              <p className="px-1 pb-4 text-title-3">All sections</p>
              {sections.map((section, index) => (
                <div key={section.title ?? index} className="mb-5 last:mb-0">
                  {section.title ? <p className="group-label px-4 pb-1.5">{section.title}</p> : null}
                  <ul className="divide-y overflow-hidden rounded-2xl bg-card shadow-card">
                    {section.items.map((item) => (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          end={exact(item)}
                          onClick={() => setMoreOpen(false)}
                          className={({ isActive }) =>
                            cn('flex h-[52px] items-center gap-3 px-4 text-[16px] tracking-[-0.01em] active:bg-accent', isActive && 'font-semibold text-primary')
                          }
                        >
                          <item.icon className="size-5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                          {item.label}
                          <ChevronRight className="ml-auto size-4 text-muted-foreground/60" aria-hidden="true" />
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </SheetContent>
        </DialogPrimitive.Root>
      ) : null}
    </nav>
  );
}

// --- Frame ------------------------------------------------------------------------------------

function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-background focus:px-4 focus:py-2 focus:shadow-elevated"
    >
      Skip to content
    </a>
  );
}

/**
 * Authenticated frame.
 *  - Desktop customers: a translucent top bar with the destinations centred, like a consumer app.
 *  - Desktop staff: a quiet sidebar, like a professional tool.
 *  - Phones and tablets, everyone: a compact top bar and a bottom tab bar within thumb reach.
 * Only one navigation is mounted at a time, so there is always exactly one "Main" landmark.
 *
 * Everything signed in shares one real-time stream and one Sphere assistant. Sphere opens from a floating
 * button on desktop (pages keep room for it at the bottom) and from the top bar on phones and tablets, so
 * nothing ever sits over the tab bar.
 */
export function AppShell() {
  return (
    <RealtimeProvider>
      <SphereProvider>
        <ShellFrame />
      </SphereProvider>
    </RealtimeProvider>
  );
}

function ShellFrame() {
  const user = useUser();
  const location = useLocation();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const sections = NAVIGATION[user.role];
  const home = HOME[user.role];
  const consumer = user.role === 'CUSTOMER';
  const page = (
    <div key={location.pathname} className="animate-rise">
      <Outlet />
    </div>
  );

  if (desktop && !consumer) {
    return (
      <div className="flex min-h-dvh bg-canvas">
        <SkipLink />
        <aside className="sticky top-0 flex h-dvh w-[264px] shrink-0 flex-col border-r border-border/70" aria-label="Sidebar">
          <div className="flex h-[68px] items-center px-5">
            <Link to={home} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
              <BrandLogo />
            </Link>
          </div>
          <SidebarNav sections={sections} />
          <div className="space-y-2 border-t border-border/70 p-3">
            <ConnectionIndicator className="mx-2" />
            <UserMenu variant="sidebar" />
          </div>
        </aside>
        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1320px] px-10 pb-28 pt-10">{page}</div>
        </main>
        <SphereLauncher variant="floating" />
      </div>
    );
  }

  const container = consumer ? 'max-w-[1120px]' : 'max-w-[1320px]';
  return (
    <div className="min-h-dvh overflow-x-clip bg-canvas">
      <SkipLink />
      <header className="sticky top-0 z-30 border-b border-border/70 bg-canvas/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-canvas/70">
        <div className={cn('mx-auto grid h-14 w-full grid-cols-[1fr_auto] items-center gap-4 px-4 sm:px-6 lg:h-16 lg:grid-cols-[1fr_auto_1fr] lg:px-10', container)}>
          <Link to={home} className="justify-self-start rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
            <BrandLogo />
          </Link>
          {desktop ? <TopNav items={sections.flatMap((s) => s.items)} /> : null}
          <div className="flex items-center gap-1 justify-self-end">
            <ConnectionIndicator className="mr-1" />
            {desktop ? null : <SphereLauncher variant="header" />}
            <UserMenu variant="avatar" />
          </div>
        </div>
      </header>
      <main
        id="main"
        className={cn('mx-auto w-full px-4 pt-6 sm:px-6 lg:px-10 lg:pb-28 lg:pt-10', container, !desktop && 'pb-[calc(6.5rem+env(safe-area-inset-bottom))]')}
      >
        {page}
      </main>
      {desktop ? <SphereLauncher variant="floating" /> : <TabBar sections={sections} />}
    </div>
  );
}
