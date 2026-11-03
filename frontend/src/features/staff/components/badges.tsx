import { AlertTriangle, Clock, OctagonAlert, Users } from 'lucide-react';
import type { AlertStatus, KycStatus, RiskLevel } from '@/lib/api/types';
import { Badge, StatusBadge, type BadgeTone } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { ALERT_STATUS_LABEL, KYC_LABEL, type WaitTone } from './format';

export function KycBadge({ status, className }: { status: KycStatus; className?: string }) {
  return <StatusBadge status={status} label={KYC_LABEL[status]} className={className} />;
}

export function AlertStatusBadge({ status, className }: { status: AlertStatus; className?: string }) {
  return <StatusBadge status={status} label={ALERT_STATUS_LABEL[status]} className={className} />;
}

/** Amber means "needs attention"; red is kept for critical risk, so a queue of high alerts isn't a wall of red */
const SEVERITY: Record<RiskLevel, { label: string; tone: BadgeTone; className?: string }> = {
  LOW: { label: 'Low', tone: 'neutral' },
  MEDIUM: { label: 'Medium', tone: 'warning' },
  HIGH: { label: 'High', tone: 'warning' },
  CRITICAL: { label: 'Critical', tone: 'danger', className: 'bg-destructive text-destructive-foreground' },
};

/** Severity always carries its name (never colour alone); high and critical also get a glyph */
export function SeverityBadge({ severity, long = false, className }: { severity: RiskLevel; long?: boolean; className?: string }) {
  const { label, tone, className: extra } = SEVERITY[severity];
  const Icon = severity === 'CRITICAL' ? OctagonAlert : severity === 'HIGH' ? AlertTriangle : null;
  return (
    <Badge tone={tone} dot={!Icon} className={cn(extra, className)}>
      {Icon ? <Icon className="size-3" strokeWidth={2.5} aria-hidden="true" /> : null}
      {long ? `${label} severity` : label}
    </Badge>
  );
}

export function WaitingBadge({ label, tone }: { label: string; tone: WaitTone }) {
  return (
    <Badge tone={tone === 'neutral' ? 'neutral' : tone} className="tnum">
      <Clock className="size-3" strokeWidth={2.5} aria-hidden="true" />
      {label}
    </Badge>
  );
}

export function SecondAnalystBadge() {
  return (
    <Badge tone="warning">
      <Users className="size-3" strokeWidth={2.5} aria-hidden="true" />
      Awaiting second analyst
    </Badge>
  );
}
