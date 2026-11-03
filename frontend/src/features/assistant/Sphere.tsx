import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/cn';

/** The panel (and the chat it holds) downloads the first time someone opens Sphere */
const SpherePanel = lazy(() => import('./SpherePanel'));

interface SphereContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SphereContext = createContext<SphereContextValue | null>(null);

/** Holds Sphere for the signed-in shell: launchers anywhere inside it open the same panel and conversation */
export function SphereProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [used, setUsed] = useState(false);
  /** The launcher that opened the panel gets focus back when it closes */
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (next) {
      setUsed(true);
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOpenState(next);
  }, []);
  const returnFocus = useCallback(() => {
    if (opener.current?.isConnected) opener.current.focus();
  }, []);
  const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <SphereContext.Provider value={value}>
      {children}
      {used ? (
        <Suspense fallback={null}>
          <SpherePanel open={open} onOpenChange={setOpen} onClosed={returnFocus} />
        </Suspense>
      ) : null}
    </SphereContext.Provider>
  );
}

/**
 * Opens Sphere. `floating`: a pill in the bottom-right corner, for desktop layouts (the page reserves room
 * for it). `header`: an icon button in the phone and tablet top bar, so nothing ever covers the tab bar.
 */
export function SphereLauncher({ variant, className }: { variant: 'floating' | 'header'; className?: string }) {
  const context = useContext(SphereContext);
  if (!context) return null;
  const common = {
    type: 'button' as const,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': context.open,
    onClick: () => context.setOpen(true),
  };
  if (variant === 'header') {
    return (
      <button
        {...common}
        aria-label="Ask Sphere"
        className={cn(
          'flex size-11 cursor-pointer items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[21px]',
          className
        )}
      >
        <MessagesSquare strokeWidth={1.8} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      {...common}
      className={cn(
        'fixed bottom-6 right-6 z-30 inline-flex h-12 cursor-pointer items-center gap-2 rounded-full bg-popover pl-4 pr-5 text-[15px] font-medium tracking-[-0.01em] text-foreground shadow-elevated transition-[transform,background-color] duration-200 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] dark:ring-1 dark:ring-white/10 [&_svg]:size-5',
        className
      )}
    >
      <MessagesSquare strokeWidth={1.8} aria-hidden="true" />
      Ask Sphere
    </button>
  );
}
