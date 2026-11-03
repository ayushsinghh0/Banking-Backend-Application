import { useId } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * A search field as on iOS and macOS: a rounded pill with the glyph inside, no visible label (the field says
 * what it searches), and a clear button once there is something to clear. The caller debounces.
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  size = 'md',
  className,
}: {
  /** Accessible name of the field */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** What can be searched for, announced with the field */
  hint?: string;
  size?: 'md' | 'lg';
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('relative min-w-0', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {hint ? (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      ) : null}
      <Search
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          size === 'lg' ? 'left-4 size-[18px]' : 'left-3.5 size-4'
        )}
        strokeWidth={2.25}
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        value={value}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={placeholder}
        aria-describedby={hintId}
        className={cn(
          'flex w-full rounded-full bg-card text-base text-foreground shadow-card transition-[box-shadow] duration-150 placeholder:text-muted-foreground',
          'hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
          '[&::-webkit-search-cancel-button]:hidden',
          size === 'lg' ? 'h-12 pl-11 pr-12 sm:text-[16px]' : 'h-11 pl-10 pr-11 sm:text-[15px]'
        )}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className={cn(
            'absolute inset-y-0 right-0 flex cursor-pointer items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            size === 'lg' ? 'w-12' : 'w-11'
          )}
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <span className="flex size-[18px] items-center justify-center rounded-full bg-muted-foreground/60 text-card">
            <X className="size-3" strokeWidth={3} aria-hidden="true" />
          </span>
        </button>
      ) : null}
    </div>
  );
}
