import { useState } from 'react';
import { Check, CreditCard, Landmark, Smartphone } from 'lucide-react';
import type { SimulatedMethod } from '@/lib/api/types';
import { formatPaise } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';

const METHODS: Array<{ value: SimulatedMethod; label: string; icon: typeof Smartphone }> = [
  { value: 'upi', label: 'UPI', icon: Smartphone },
  { value: 'card', label: 'Card', icon: CreditCard },
  { value: 'netbanking', label: 'Net banking', icon: Landmark },
];

/**
 * The development stand-in for Razorpay Checkout (payment mode `simulator`). It looks like part of
 * BankSphere, never like a real payment page, and says plainly that nothing real happens.
 */
export function TestCheckoutSheet({
  open,
  amountPaise,
  accountName,
  busy,
  problem,
  onPay,
  onDecline,
  onDismiss,
}: {
  open: boolean;
  amountPaise: string;
  accountName: string;
  busy: 'pay' | 'decline' | null;
  problem: { title: string; description: string } | null;
  onPay: (method: SimulatedMethod) => void;
  onDecline: (method: SimulatedMethod) => void;
  onDismiss: () => void;
}) {
  const [method, setMethod] = useState<SimulatedMethod>('upi');
  const amount = formatPaise(amountPaise);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onDismiss()}>
      <DialogContent size="sm" onEscapeKeyDown={(e) => busy && e.preventDefault()} onInteractOutside={(e) => busy && e.preventDefault()}>
        <DialogHeader title="Test checkout" description={`${amount} to ${accountName}`} />
        <Callout tone="warning" title="Simulated payment — no real money moves">
          This development checkout stands in for Razorpay. Choose how the payment should end.
        </Callout>
        <fieldset className="space-y-2">
          <legend className="pb-2 text-[13px] font-medium tracking-[-0.005em]">Pay with</legend>
          <div className="grid grid-cols-3 gap-2">
            {METHODS.map(({ value, label, icon: Icon }) => (
              <label
                key={value}
                className="relative flex min-h-[76px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[13px] font-medium transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary-soft/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  type="radio"
                  name="test-checkout-method"
                  value={value}
                  checked={method === value}
                  onChange={() => setMethod(value)}
                  disabled={Boolean(busy)}
                  className="sr-only"
                />
                <Icon className="size-5 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
                {label}
                {method === value ? (
                  <Check className="absolute right-2 top-2 size-3.5 text-primary" strokeWidth={2.5} aria-hidden="true" />
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>
        {problem ? (
          <Callout tone="danger" title={problem.title}>
            {problem.description}
          </Callout>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" size="lg" onClick={() => onDecline(method)} loading={busy === 'decline'} disabled={Boolean(busy)}>
            Decline
          </Button>
          <Button size="lg" onClick={() => onPay(method)} loading={busy === 'pay'} disabled={Boolean(busy)}>
            Pay {amount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
