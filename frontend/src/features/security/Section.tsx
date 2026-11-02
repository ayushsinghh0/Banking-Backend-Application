import { useId, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';

/** A titled tile on the security page; its title names the region for assistive technology */
export function Section({ title, description, children, aside }: { title: string; description: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle id={id}>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {aside}
        </CardHeader>
        <CardContent className="pt-3">{children}</CardContent>
      </section>
    </Card>
  );
}
