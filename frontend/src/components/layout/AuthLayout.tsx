import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';
import { LockKeyhole } from 'lucide-react';
import { cn } from '@/lib/cn';
import { BrandLogo } from './Brand';
import { ThemeToggle } from './AppShell';

/** Frame for every signed-out page: one calm column, nothing competing with the form */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background dark:bg-canvas">
      <header className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-5 pt-[env(safe-area-inset-top)] sm:px-8">
        <div className="flex h-16 items-center">
          <Link to="/login" className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
            <BrandLogo />
          </Link>
        </div>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 justify-center px-5 pb-16 pt-6 sm:items-center sm:px-8 sm:pt-0">
        <div className="w-full max-w-[400px] animate-slide-up">
          <Outlet />
        </div>
      </main>
      <footer className="mx-auto w-full max-w-[1120px] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-8">
        <div className="flex flex-col items-center gap-1.5 border-t pt-5 text-center text-[12px] leading-4 text-muted-foreground sm:flex-row sm:justify-between sm:text-left">
          <p>© {new Date().getFullYear()} BankSphere</p>
          <p className="inline-flex items-center gap-1.5">
            <LockKeyhole className="size-3.5" aria-hidden="true" /> Encrypted session · two-step verification
          </p>
        </div>
      </footer>
    </div>
  );
}

export function AuthHeading({ title, description, icon, className }: { title: string; description?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-8 flex flex-col items-center text-center', className)}>
      {icon ? <div className="mb-5">{icon}</div> : null}
      <h1 className="text-[28px] font-bold leading-[34px] tracking-[-0.03em] sm:text-[32px] sm:leading-[38px]">{title}</h1>
      {description ? <p className="mt-2 max-w-[22rem] text-pretty text-[15px] leading-[22px] text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** A quiet glyph above an auth heading (envelope, key, shield…) */
export function AuthIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-14 items-center justify-center rounded-full bg-muted text-foreground [&_svg]:size-6 [&_svg]:stroke-[1.6]">{children}</span>
  );
}
