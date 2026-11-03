import { isRouteErrorResponse, useRouteError } from 'react-router';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/layout/Brand';

/** Last-resort boundary: a failed chunk download (new deploy) or an unexpected render error */
export function RouteError() {
  const error = useRouteError();
  const chunkFailed = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
  const title = isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : chunkFailed ? 'A new version is available' : 'Something went wrong';
  const description = chunkFailed
    ? 'BankSphere was updated while this page was open. Reload to continue — nothing you submitted was lost.'
    : 'An unexpected error stopped this page from loading. Reloading usually fixes it.';
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center" role="alert">
      <BrandMark className="size-11" />
      <h1 className="mt-8 text-[28px] font-bold leading-[34px] tracking-[-0.03em]">{title}</h1>
      <p className="mt-3 max-w-md text-pretty text-[15px] leading-[22px] text-muted-foreground">{description}</p>
      <Button size="lg" className="mt-8" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden="true" /> Reload
      </Button>
    </div>
  );
}
