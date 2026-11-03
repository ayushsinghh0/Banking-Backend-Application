import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, type RouteObject } from 'react-router';
import { StepUpProvider } from '@/features/security/StepUp';
import { QueryClient } from '@tanstack/react-query';
import { HttpResponse } from 'msw';
import { AppProviders } from '@/app/App';
import { createServices } from '@/lib/api';
import type { Role } from '@/lib/auth/session';
import { makeAccessToken, type TokenClaims } from './tokens';

export const API = 'http://localhost:3000/api/v1';
export const apiUrl = (path: string) => `${API}${path}`;

/** A successful API envelope */
export const ok = (data: unknown, status = 200) => HttpResponse.json({ success: true, data }, { status });

/** An API error envelope */
export const fail = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ error: { code, message, correlationId: 'test-corr', ...extra } }, { status });

/** Shows where the router ended up, for navigation assertions */
export function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location" data-state={JSON.stringify(location.state ?? null)}>
      {location.pathname}
      {location.search}
    </div>
  );
}

export interface RenderOptions {
  /** Signed in as this role (default CUSTOMER); null renders signed out */
  role?: Role | null;
  claims?: Partial<TokenClaims>;
  /** Initial URL, including any #fragment */
  route?: string;
  /** Route pattern the element is mounted at (default: the route's pathname) */
  path?: string;
  /** Extra routes, e.g. destinations to assert navigation */
  routes?: RouteObject[];
}

export function renderWithApp(ui: ReactElement, options: RenderOptions = {}) {
  const { role = 'CUSTOMER', claims, route = '/', routes = [] } = options;
  const services = createServices();
  if (role) services.session.setAccessToken(makeAccessToken({ role, mfa: role !== 'CUSTOMER', ...claims }));
  else services.session.clear(false);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 }, mutations: { retry: false } },
  });
  const path = options.path ?? route.split(/[?#]/)[0] ?? '/';
  const router = createMemoryRouter(
    [
      {
        element: (
          <StepUpProvider>
            <Outlet />
          </StepUpProvider>
        ),
        children: [{ path, element: ui }, ...routes, { path: '*', element: <LocationProbe /> }],
      },
    ],
    { initialEntries: [route] }
  );
  const user = userEvent.setup();
  const result = render(
    <AppProviders services={services} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return { ...result, services, queryClient, router, user };
}

/** Renders the real route table (guards, layouts, lazy pages) at a URL */
export async function renderRoute(route: string, options: Omit<RenderOptions, 'route' | 'path' | 'routes'> = {}) {
  const { routes } = await import('@/app/routes');
  const { role = 'CUSTOMER', claims } = options;
  const services = createServices();
  if (role) services.session.setAccessToken(makeAccessToken({ role, mfa: role !== 'CUSTOMER', ...claims }));
  else services.session.clear(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const router = createMemoryRouter(routes, { initialEntries: [route] });
  const user = userEvent.setup();
  const result = render(
    <AppProviders services={services} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return { ...result, services, queryClient, router, user };
}
