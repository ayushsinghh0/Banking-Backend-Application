import { useState, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { createServices, type AppServices } from '@/lib/api';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import { createQueryClient } from '@/lib/query';
import { useTheme } from '@/lib/theme';
import { TooltipProvider } from '@/components/ui/overlays';
import { routes } from './routes';

/** Notifications drop in at the top centre, like the system's: a quiet card, colour only on the icon */
function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="top-center"
      closeButton
      offset={16}
      gap={10}
      toastOptions={{
        duration: 6000,
        classNames: {
          toast:
            '!items-start !gap-3 !rounded-2xl !border-0 !bg-popover/95 !px-4 !py-3.5 !font-sans !text-popover-foreground !shadow-elevated backdrop-blur-xl dark:!ring-1 dark:!ring-white/10',
          title: '!text-[14px] !font-semibold !leading-5 !tracking-[-0.01em]',
          description: '!text-[13px] !leading-[18px] !text-muted-foreground',
          icon: '!mt-0.5',
          closeButton: '!border-border !bg-popover !text-muted-foreground hover:!text-foreground',
          success: '[&_[data-icon]]:!text-success',
          error: '[&_[data-icon]]:!text-destructive',
          warning: '[&_[data-icon]]:!text-warning',
          info: '[&_[data-icon]]:!text-primary',
        },
      }}
    />
  );
}

/** Providers shared by the app and by component tests */
export function AppProviders({ services, queryClient, children }: { services: AppServices; queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider services={services}>
        <TooltipProvider delayDuration={250}>
          {children}
          <ThemedToaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [services] = useState(() => createServices());
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <AppProviders services={services} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
