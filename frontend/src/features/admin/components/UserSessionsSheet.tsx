import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { DirectoryUser } from '@/lib/api/types';
import { Avatar } from '@/components/ui/primitives';
import { DetailSheet } from '@/features/ops/components/DetailSheet';
import { UserSessionsPanel } from '@/features/ops/UserSessionsPanel';
import { roleLabel } from './roles';

/**
 * One person from the directory: who they are and where they're signed in. Opened over the list, as a side
 * sheet on desktop and a full sheet on phones; administrators can sign a session out from here.
 */
export function UserSessionsSheet({ user, canRevoke, onClose }: { user: DirectoryUser; canRevoke: boolean; onClose: () => void }) {
  const facts = [roleLabel(user.role), user.isActive ? null : 'Sign-in disabled', user.mfaEnabled ? 'Two-factor on' : 'Two-factor off'].filter(Boolean);
  return (
    <DetailSheet open onOpenChange={(open) => !open && onClose()} title={`Sessions for ${user.email}`}>
      <div className="space-y-5">
        <div className="flex items-center gap-3 pr-12">
          <Avatar name={user.email} className="size-11 text-[15px]" />
          <div className="min-w-0">
            <h2 className="truncate text-title-3" title={user.email}>
              {user.email}
            </h2>
            <p className="text-[14px] leading-5 text-muted-foreground">{facts.join(' · ')}</p>
          </div>
        </div>
        {/* The sheet is the surface: the panel sits on it without a tile of its own */}
        <UserSessionsPanel userId={user.id} name={user.email} canRevoke={canRevoke} className="-mx-5 bg-transparent shadow-none sm:-mx-6" />
        {user.role === 'CUSTOMER' ? (
          <Link
            to={`/customers/${encodeURIComponent(user.id)}`}
            className="-mx-2 flex h-11 items-center justify-between rounded-xl px-2 text-[15px] tracking-[-0.01em] text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open customer profile
            <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </DetailSheet>
  );
}
