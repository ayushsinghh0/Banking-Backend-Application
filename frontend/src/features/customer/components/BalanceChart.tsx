import { useId } from 'react';
import { Area, AreaChart, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { formatPaise } from '@/lib/money';
import type { BalancePoint } from '../cashflow';
import { useElementWidth } from '../hooks';

function BalanceTooltip({ active, payload }: TooltipProps<number, string>) {
  const point = payload?.[0]?.payload as BalancePoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-xl bg-popover px-3 py-2 shadow-elevated dark:ring-1 dark:ring-white/10">
      <p className="text-[11.5px] font-medium text-muted-foreground">{point.label}</p>
      <p className="text-[14px] font-semibold tracking-[-0.01em] tnum">{formatPaise(point.balancePaise)}</p>
    </div>
  );
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What a screen reader gets instead of the line */
export function balanceSummary(points: BalancePoint[]): string {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `Total balance from ${first.label} to ${last.label}: ${formatPaise(first.balancePaise)} to ${formatPaise(last.balancePaise)}.`;
}

/** The total balance over time: one line, no gridlines, the exact amount on hover */
export function BalanceChart({ points, height = 140 }: { points: BalancePoint[]; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const gradientId = `balance-${useId().replace(/:/g, '')}`;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Breathing room above and below so a flat or tiny change doesn't hug the edges
  const pad = (max - min) * 0.3 || Math.max(Math.abs(max) * 0.08, 1);

  return (
    <figure className="m-0">
      <div ref={ref} role="img" aria-label={balanceSummary(points)} style={{ height }}>
        {width > 0 ? (
          <AreaChart width={width} height={height} data={points} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" hide />
            <YAxis hide domain={[min - pad, max + pad]} />
            <Tooltip
              cursor={{ stroke: 'hsl(var(--foreground))', strokeOpacity: 0.12, strokeWidth: 1 }}
              content={<BalanceTooltip />}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4.5, strokeWidth: 2.5, stroke: 'hsl(var(--card))', fill: 'hsl(var(--primary))' }}
              isAnimationActive={!reducedMotion()}
              animationDuration={800}
              animationEasing="ease-out"
            />
          </AreaChart>
        ) : null}
      </div>
      <figcaption className="mt-2 flex justify-between text-[12px] font-medium text-muted-foreground tnum">
        <span>{points[0]!.label}</span>
        <span>Today</span>
      </figcaption>
    </figure>
  );
}
