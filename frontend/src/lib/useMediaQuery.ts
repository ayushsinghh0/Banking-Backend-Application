import { useEffect, useState } from 'react';

const matches = (query: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/** Live result of a CSS media query (false where matchMedia is unavailable) */
export function useMediaQuery(query: string): boolean {
  const [state, setState] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = () => setState(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return state;
}

/** The layout switches from phone/tablet (tab bar) to desktop (top bar or sidebar) at Tailwind's lg breakpoint */
export const DESKTOP_QUERY = '(min-width: 1024px)';
