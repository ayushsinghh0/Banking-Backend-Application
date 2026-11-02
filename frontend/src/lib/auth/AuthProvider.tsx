import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppServices } from '@/lib/api';
import type { ApiClient } from '@/lib/api/client';
import type { Endpoints } from '@/lib/api/endpoints';
import type { LoginResult, SessionTokens } from '@/lib/api/types';
import { isMfaChallenge } from '@/lib/api/types';
import { hasFreshStepUp, isStaffRole, type SessionStatus, type SessionUser } from './session';

interface AuthContextValue {
  status: SessionStatus;
  user: SessionUser | null;
  api: Endpoints;
  /** The raw HTTP client, for feature modules that define their own endpoint functions */
  client: ApiClient;
  /** The current access token, for streaming requests made outside the client (server-sent events) */
  getAccessToken: () => string | null;
  /**
   * Renews the access token through the session (cookie refresh, serialised across tabs). Resolves null when
   * the session is over. Used when a long-lived stream is told to re-authenticate.
   */
  refreshAccessToken: () => Promise<string | null>;
  /** Adopt tokens from login, MFA, password change or step-up */
  applyTokens: (tokens: Pick<SessionTokens, 'accessToken'>) => void;
  /** Handles a login response: returns the MFA challenge if one is needed, otherwise signs in */
  completeLogin: (result: LoginResult) => { challengeToken: string } | null;
  signOut: () => Promise<void>;
  /** Drops the local session without calling the server (it already ended every session) */
  endLocalSession: () => void;
  /** Staff who signed in without the second factor may only enrol their authenticator */
  needsMfaEnrolment: boolean;
  hasFreshStepUp: () => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  const { session, api, client } = services;
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => `${session.status}:${session.getAccessToken() ?? ''}`
  );

  useEffect(() => {
    if (session.status === 'unknown') void session.restore();
  }, [session]);

  // Never show one user's cached data to the next person who signs in on this device
  useEffect(() => {
    if (session.status === 'anonymous') queryClient.clear();
  }, [snapshot, session, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const user = session.user;
    return {
      status: session.status,
      user,
      api,
      client,
      getAccessToken: session.getAccessToken,
      refreshAccessToken: () => session.refresh(),
      applyTokens: (tokens) => session.setAccessToken(tokens.accessToken),
      completeLogin: (result) => {
        if (isMfaChallenge(result)) return { challengeToken: result.challengeToken };
        queryClient.clear();
        session.setAccessToken(result.tokens.accessToken);
        return null;
      },
      signOut: async () => {
        await session.logout();
        queryClient.clear();
      },
      endLocalSession: () => {
        session.clear(true);
        queryClient.clear();
      },
      needsMfaEnrolment: Boolean(user && isStaffRole(user.role) && !user.mfa),
      hasFreshStepUp: () => hasFreshStepUp(session.user),
    };
    // snapshot changes whenever the session does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, session, api, client, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user (only call inside authenticated routes) */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('useUser called without a signed-in user');
  return user;
}

export function useApi(): Endpoints {
  return useAuth().api;
}

export function useApiClient(): ApiClient {
  return useAuth().client;
}
