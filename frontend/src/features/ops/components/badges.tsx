import { Badge } from '@/components/ui/primitives';
import type { TopUpStatus } from '../api';
import { TOP_UP_STATUS, topUpStatusLabel } from '../format';

/** A top-up's status in words, coloured only where it means something (see TOP_UP_STATUS) */
export function TopUpStatusBadge({ status, className }: { status: TopUpStatus; className?: string }) {
  return (
    <Badge tone={TOP_UP_STATUS[status]?.tone ?? 'neutral'} dot className={className}>
      {topUpStatusLabel(status)}
    </Badge>
  );
}
