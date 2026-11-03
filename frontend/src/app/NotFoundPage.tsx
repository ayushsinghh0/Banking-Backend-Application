import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/layout/Brand';

export default function NotFoundPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <BrandMark className="size-11" />
      <p className="mt-8 text-[13px] font-semibold text-muted-foreground tnum">Error 404</p>
      <h1 className="mt-2 text-[28px] font-bold leading-[34px] tracking-[-0.03em] sm:text-[34px] sm:leading-[40px]">We couldn’t find that page</h1>
      <p className="mt-3 max-w-sm text-pretty text-[15px] leading-[22px] text-muted-foreground">The link may be out of date, or the page may have moved.</p>
      <Button asChild size="lg" className="mt-8">
        <Link to="/">Go to my home page</Link>
      </Button>
    </main>
  );
}
