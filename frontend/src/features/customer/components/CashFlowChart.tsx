import { Bar, BarChart, ReferenceLine, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { LineChart as LineChartIcon } from 'lucide-react';
import { compactRupees, formatPaise } from '@/lib/money';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { ErrorState } from '@/components/ui/data';
import type { CashFlow, DayFlow } from '../cashflow';
import { useElementWidth } from '../hooks';

const CHART_HEIGHT = 220;
const axisTick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

function FlowTooltip({ active, payload }: TooltipProps<number, string>) {
  const day = payload?.[0]?.payload as DayFlow | undefined;
  if (!active || !day) return null;
  return (
    <div className="min-w-[11rem] rounded-xl bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-elevated dark:ring-1 dark:ring-white/10">
      <p className="mb-1 font-medium">{day.label}</p>
      <p className="flex justify-between gap-4">
        <span className="text-muted-foreground">Money in</span>
        <span className="font-medium text-success tnum">{formatPaise(day.inPaise)}</span>
      </p>
      <p className="flex justify-between gap-4">
        <span className="text-muted-foreground">Money out</span>
        <span className="font-medium tnum">{formatPaise(day.outPaise)}</span>
      </p>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** The text a screen reader gets instead of the bars */
export function cashFlowSummary(flow: CashFlow): string {
  const net = BigInt(flow.totalIn) - BigInt(flow.totalOut);
  const parts = [
    `In the last 30 days, ${formatPaise(flow.totalIn)} came in and ${formatPaise(flow.totalOut)} went out (net ${formatPaise(net, { sign: 'always' })}).`,
  ];
  if (flow.busiestDay) parts.push(`You spent the most on ${flow.busiestDay.label}: ${formatPaise(flow.busiestDay.outPaise)}.`);
  return parts.join(' ');
}

/** Money in (green, above the axis) and money out (ink, below) per day, with exact amounts in the tooltip. No gridlines. */
export function CashFlowChart({
  flow,
  loading,
  error,
  onRetry,
}: {
  flow: CashFlow | null;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();

  if (error) return <ErrorState error={error} onRetry={onRetry} className="py-8" />;
  if (loading || !flow) {
    return (
      <div aria-busy="true" className="space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-[220px] w-full" />
      </div>
    );
  }
  if (!flow.hasActivity) {
    return (
      <EmptyState
        icon={LineChartIcon}
        title="No money in or out in the last 30 days"
        description="Once you send or receive money, you’ll see how it flows here."
        className="py-10"
      />
    );
  }

  const animate = !prefersReducedMotion();
  return (
    <figure className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2" aria-hidden="true">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-success" />
          <span className="text-[13px] text-muted-foreground">Money in</span>
          <span className="text-sm font-semibold tnum">{formatPaise(flow.totalIn)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-foreground/70" />
          <span className="text-[13px] text-muted-foreground">Money out</span>
          <span className="text-sm font-semibold tnum">{formatPaise(flow.totalOut)}</span>
        </div>
      </div>
      <div ref={ref} className="h-[220px] w-full" aria-hidden="true">
        {width > 0 ? (
          <BarChart
            width={width}
            height={CHART_HEIGHT}
            data={flow.days}
            stackOffset="sign"
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            barCategoryGap="20%"
          >
            <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
            <YAxis
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => compactRupees(String(Math.round(value)))}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Tooltip content={<FlowTooltip />} cursor={{ fill: 'hsl(var(--muted))' }} />
            <Bar dataKey="in" name="Money in" stackId="flow" fill="hsl(var(--success))" radius={2} maxBarSize={14} isAnimationActive={animate} />
            <Bar dataKey="out" name="Money out" stackId="flow" fill="hsl(var(--foreground) / 0.7)" radius={2} maxBarSize={14} isAnimationActive={animate} />
          </BarChart>
        ) : null}
      </div>
      <figcaption className="sr-only">{cashFlowSummary(flow)}</figcaption>
    </figure>
  );
}
