import { useState } from 'react';
import { useLocation } from 'react-router';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Reads the one-time token that email links carry in the URL fragment (#token=…, which never reaches
 * servers or Referer headers) and removes it from the address bar so it doesn't linger in history.
 */
export function useFragmentToken(): string | null {
  const location = useLocation();
  const [token] = useState(() => {
    const raw = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
    return raw && TOKEN_PATTERN.test(raw) ? raw : null;
  });
  if (typeof window !== 'undefined' && window.location.hash.includes('token=')) {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }
  return token;
}
