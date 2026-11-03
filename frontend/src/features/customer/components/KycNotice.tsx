import { Link } from 'react-router';
import { ArrowRight, UserRoundPlus } from 'lucide-react';
import type { CustomerProfile, KycStatus } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Callout, Card } from '@/components/ui/primitives';

/** Why a customer can't open an account yet, or null when they can (or we don't know yet) */
export function openAccountBlocker(kycStatus: KycStatus | null | undefined): string | null {
  if (kycStatus === undefined || kycStatus === 'VERIFIED') return null;
  if (kycStatus === null) return 'Complete your profile and identity check to open an account.';
  if (kycStatus === 'PENDING') return 'You can open an account once we’ve verified your identity.';
  return 'Your identity check wasn’t successful. Contact the bank to open an account.';
}

/**
 * Where the customer stands with identity verification: an onboarding card when there is no profile yet,
 * a banner while it is pending or after it was rejected, nothing once verified.
 */
export function KycNotice({ profile, className }: { profile: CustomerProfile | null | undefined; className?: string }) {
  if (profile === undefined || profile?.kycStatus === 'VERIFIED') return null;
  if (profile === null) {
    return (
      <Card className={className}>
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:p-7">
          <UserRoundPlus className="size-8 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-headline">Complete your profile so we can verify your identity</h2>
            <p className="text-[14px] leading-5 text-muted-foreground">
              It takes a couple of minutes. Once we’ve verified your identity you can open accounts and move money.
            </p>
          </div>
          <Button asChild size="lg" className="self-start sm:self-auto">
            <Link to="/profile">
              Complete your profile <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </Card>
    );
  }
  if (profile.kycStatus === 'PENDING') {
    return (
      <Callout tone="warning" className={className} title="We’re verifying your identity">
        You can open accounts once it’s done. We’ll update your{' '}
        <Link to="/profile" className="font-medium text-primary underline-offset-2 hover:underline">
          profile
        </Link>{' '}
        when the check is complete.
      </Callout>
    );
  }
  return (
    <Callout tone="danger" className={className} title="We couldn’t verify your identity">
      Please contact the bank to find out what’s needed. If any of your details are wrong, you can correct them on your{' '}
      <Link to="/profile" className="font-medium text-primary underline-offset-2 hover:underline">
        profile
      </Link>
      , which sends them for verification again.
    </Callout>
  );
}
