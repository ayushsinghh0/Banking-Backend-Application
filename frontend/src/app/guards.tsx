import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '@/lib/auth/AuthProvider';
import type { Role } from '@/lib/auth/session';
import { BrandMark } from '@/components/layout/Brand';
import { HOME } from './navigation';

export function FullPageLoader({ label = 'Loading your workspace' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas" role="status" aria-live="polite">
      <BrandMark className="size-10 animate-pulse" />
      <p className="text-sm text-muted-foreground">{label}…</p>
    </div>
  );
}

/** Signed-in users only; staff who still have to enrol their authenticator are sent to enrolment */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, needsMfaEnrolment } = useAuth();
  const location = useLocation();
  if (status === 'unknown') return <FullPageLoader />;
  if (status === 'anonymous') {
    // The hash is kept so a token from an email link (e.g. /mfa/enrol#token=…) survives signing in
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  }
  if (needsMfaEnrolment && location.pathname !== '/mfa/enrol') {
    return <Navigate to="/mfa/enrol" replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

/** Restricts a route to roles; everyone else lands on their own home page */
export function RequireRole({ roles, children }: { roles: readonly Role[]; children?: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to={HOME[user.role]} replace />;
  return children ? <>{children}</> : <Outlet />;
}

/** Sign-in pages: an existing session goes straight to the app */
export function PublicOnly({ children }: { children?: ReactNode }) {
  const { status, user, needsMfaEnrolment } = useAuth();
  const location = useLocation();
  if (status === 'unknown') return <FullPageLoader label="Checking your session" />;
  if (status === 'authenticated' && user) {
    if (needsMfaEnrolment) return <Navigate to="/mfa/enrol" replace />;
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : HOME[user.role]} replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

/** "/" goes to the right home page for whoever is signed in */
export function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'unknown') return <FullPageLoader />;
  return <Navigate to={user ? HOME[user.role] : '/login'} replace />;
}
