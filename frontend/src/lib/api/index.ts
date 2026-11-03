import { ApiClient } from './client';
import { createEndpoints, type Endpoints } from './endpoints';
import { SessionStore } from '@/lib/auth/session';

export interface AppServices {
  session: SessionStore;
  client: ApiClient;
  api: Endpoints;
}

/** Wires the in-memory session to the HTTP client. One instance per app (tests create their own). */
export function createServices(options: { onSessionExpired?: () => void } = {}): AppServices {
  const session = new SessionStore();
  const client = new ApiClient({
    getAccessToken: session.getAccessToken,
    refreshAccessToken: () => session.refresh(),
    onSessionExpired: () => {
      session.clear(false);
      options.onSessionExpired?.();
    },
  });
  return { session, client, api: createEndpoints(client) };
}

export { ApiError, describeError, isApiError } from './errors';
export type { Endpoints } from './endpoints';
