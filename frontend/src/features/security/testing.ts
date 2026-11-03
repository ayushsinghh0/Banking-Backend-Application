/**
 * Test-only helpers for the security settings: registers the sessions and sign-in activity endpoints.
 * Not imported by application code.
 */
import { http } from 'msw';
import type { DeviceSession, SecurityEvent } from '@/lib/api/types';
import { server } from '@/test/server';
import { apiUrl, ok } from '@/test/render';
import { aDeviceSession } from '@/test/fixtures';

export function mockSecurityApi(mock: { sessions?: DeviceSession[]; events?: SecurityEvent[] } = {}): void {
  server.use(
    http.get(apiUrl('/auth/sessions'), () => ok(mock.sessions ?? [aDeviceSession()])),
    http.get(apiUrl('/auth/security-events'), () => ok(mock.events ?? []))
  );
}
