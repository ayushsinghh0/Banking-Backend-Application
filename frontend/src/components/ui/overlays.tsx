import { forwardRef, useState, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from './button';

// --- Dialog -----------------------------------------------------------------------------------

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlayClass =
  'fixed inset-0 z-50 bg-black/40 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-300';
/*
 * Phones: a sheet that rises from the bottom edge, clear of the home indicator.
 * From the sm breakpoint: a centred panel that scales in.
 */
const panelClass = [
  'fixed z-50 grid gap-5 overflow-y-auto bg-popover text-popover-foreground shadow-elevated dark:ring-1 dark:ring-white/[0.08]',
  'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[28px] px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-7',
  'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] sm:p-7',
  'duration-300 ease-spring data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
  'max-sm:data-[state=open]:slide-in-from-bottom-[40%] max-sm:data-[state=closed]:slide-out-to-bottom-[40%]',
  'sm:data-[state=open]:zoom-in-[0.97] sm:data-[state=closed]:zoom-out-[0.97] sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%] sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%]',
].join(' ');

/** The grabber shown at the top of a bottom sheet on phones */
function Grabber() {
  return <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-[5px] w-9 -translate-x-1/2 rounded-full bg-foreground/15 sm:hidden" />;
}

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: 'sm' | 'md' | 'lg'; hideClose?: boolean }
>(({ className, children, size = 'md', hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(panelClass, size === 'sm' && 'sm:max-w-sm', size === 'md' && 'sm:max-w-lg', size === 'lg' && 'sm:max-w-2xl', className)}
      {...props}
    >
      <Grabber />
      {children}
      {hideClose ? null : (
        <DialogPrimitive.Close
          className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer sm:right-5 sm:top-5"
          aria-label="Close"
        >
          <X className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ title, description, icon }: { title: ReactNode; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 pr-10">
      {icon ? <div className="shrink-0">{icon}</div> : null}
      <div className="space-y-1.5">
        <DialogPrimitive.Title className="text-title-3">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="text-pretty text-[14px] leading-5 text-muted-foreground">{description}</DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
      </div>
    </div>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end [&>*]:max-sm:h-12 [&>*]:max-sm:w-full', className)} {...props} />;
}

/** Slide-over panel (mobile navigation, detail drawers) */
export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'left' | 'right' | 'bottom'; title: string }
>(({ className, children, side = 'right', title, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed inset-y-0 z-50 flex w-[min(100vw,26rem)] flex-col bg-popover text-popover-foreground shadow-elevated duration-300 ease-spring data-[state=open]:animate-in data-[state=closed]:animate-out',
        side === 'right' && 'right-0 data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
        side === 'left' && 'left-0 data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
        side === 'bottom' &&
          'inset-x-0 bottom-0 top-auto w-full max-h-[85dvh] rounded-t-[28px] pb-[env(safe-area-inset-bottom)] pt-6 data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
        className
      )}
      {...props}
    >
      {side === 'bottom' ? <Grabber /> : null}
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
        aria-label="Close panel"
      >
        <X className="size-4" strokeWidth={2.25} aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

// --- Confirmation -----------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'destructive';
  /** Resolves/rejects; the dialog stays open and shows a spinner until it settles */
  onConfirm: () => Promise<unknown> | void;
  children?: ReactNode;
}

/** Explicit confirmation for irreversible or sensitive actions */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={overlayClass} />
        <AlertDialogPrimitive.Content className={cn(panelClass, 'sm:max-w-md')}>
          <Grabber />
          <div className="space-y-1.5">
            <AlertDialogPrimitive.Title className="text-title-3">{title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className={cn('text-pretty text-[14px] leading-5 text-muted-foreground', !description && 'sr-only')}>
              {description ?? title}
            </AlertDialogPrimitive.Description>
          </div>
          {children}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end [&>*]:max-sm:h-12">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary" disabled={busy}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              variant={tone === 'destructive' ? 'destructive' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } catch {
                  // The caller surfaces the error (toast/inline); keep the dialog open to retry
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

// --- Dropdown menu ----------------------------------------------------------------------------

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[13rem] overflow-hidden rounded-[14px] bg-popover/95 p-1.5 text-popover-foreground shadow-elevated backdrop-blur-xl dark:ring-1 dark:ring-white/[0.08] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.96] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.96] duration-150',
        className
      )}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

const menuItemClass =
  'relative flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-[14px] outline-none transition-colors focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground';

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(menuItemClass, destructive && 'text-destructive focus:bg-destructive-soft [&_svg]:text-destructive', className)}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;

export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownPrimitive.RadioItem ref={ref} className={cn(menuItemClass, className)} {...props}>
    {children}
    <DropdownPrimitive.ItemIndicator className="ml-auto flex">
      <Check className="!text-foreground" aria-hidden="true" />
    </DropdownPrimitive.ItemIndicator>
  </DropdownPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <DropdownPrimitive.Label className="px-2.5 py-2 text-[12.5px] leading-[18px] text-muted-foreground">{children}</DropdownPrimitive.Label>;
}

export function DropdownMenuSeparator() {
  return <DropdownPrimitive.Separator className="-mx-1.5 my-1.5 h-px bg-border" />;
}

// --- Tabs -------------------------------------------------------------------------------------

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'scrollbar-none inline-flex h-9 max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto rounded-full bg-muted p-[3px] text-muted-foreground [&>*]:shrink-0',
        className
      )}
      {...props}
    />
  )
);
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium tracking-[-0.005em] transition-[background-color,color,box-shadow] duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-segment data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-thumb',
        className
      )}
      {...props}
    />
  )
);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  ({ className, ...props }, ref) => <TabsPrimitive.Content ref={ref} className={cn('mt-5 focus-visible:outline-none', className)} {...props} />
);
TabsContent.displayName = 'TabsContent';

// --- Tooltip ----------------------------------------------------------------------------------

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-lg bg-foreground px-2.5 py-1.5 text-[12px] font-medium text-background shadow-raised data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export type { ButtonProps };
