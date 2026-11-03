/**
 * A stream lives as long as its access token: `reauth` at expiry, and earlier when the token is revoked.
 */
import { InMemoryTokenStateStore, TokenStateStore } from '@banksphere/common';
import { aUser, rig } from './support/harness';
import { settle } from './support/fake-redis';

describe('re-authentication', () => {
  const T0 = Date.parse('2026-10-28T10:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: T0 });
  });
  afterEach(() => jest.useRealTimers());

  it('sends `reauth` and closes exactly when the access token expires', async () => {
    const r = rig();
    const { stream } = await r.connect(aUser({ expiresAt: T0 / 1000 + 900 }));
    jest.advanceTimersByTime(899_999);
    expect(stream!.closed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(stream!.sent.at(-1)).toEqual({ event: 'reauth', data: { reason: 'token_expired' }, id: undefined });
    expect(stream!.closed).toBe(true);
    await settle();
    expect(r.manager.size).toBe(0);
    expect(r.subscriber.channels.size).toBe(0);
    expect(r.server.zsets.get('rt:streams:user:cust-1')!.size).toBe(0);
  });

  it('a token that is about to expire gets `reauth` right after `ready`', async () => {
    const r = rig();
    const { stream } = await r.connect(aUser({ expiresAt: T0 / 1000 }));
    jest.advanceTimersByTime(0);
    expect(stream!.sent.map((s) => s.event)).toEqual(['ready', 'reauth']);
  });

  it('a REVOKED token (logout, revoked session, password change) ends the stream at the next check', async () => {
    const tokenState = new InMemoryTokenStateStore();
    const r = rig({ tokenState, settings: { revalidateSeconds: 60 } });
    const user = aUser({ expiresAt: T0 / 1000 + 900 });
    const { stream } = await r.connect(user);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(stream!.closed).toBe(false);

    await tokenState.revokeSession(user.sessionId!);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(stream!.sent.at(-1)).toEqual({ event: 'reauth', data: { reason: 'token_revoked' }, id: undefined });
    expect(stream!.closed).toBe(true);
  });

  it('an unreachable token store does not cut streams (they still end at expiry)', async () => {
    const tokenState: TokenStateStore = { ...new InMemoryTokenStateStore(), isAccessTokenRevoked: jest.fn().mockRejectedValue(new Error('Connection is closed.')) } as any;
    const r = rig({ tokenState, settings: { revalidateSeconds: 60 } });
    const { stream } = await r.connect(aUser({ expiresAt: T0 / 1000 + 900 }));
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(60_000);
      await settle();
    }
    expect(stream!.closed).toBe(false);
    expect(tokenState.isAccessTokenRevoked).toHaveBeenCalledTimes(5);
    jest.advanceTimersByTime(600_000);
    expect(stream!.closed).toBe(true);
  });

  it('checks never overlap: a slow token store is not asked again until it has answered', async () => {
    let answer: (revoked: boolean) => void = () => undefined;
    const isAccessTokenRevoked = jest.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const r = rig({ tokenState: { isAccessTokenRevoked } as unknown as TokenStateStore, settings: { revalidateSeconds: 60 } });
    const { stream } = await r.connect(aUser({ expiresAt: T0 / 1000 + 900 }));
    jest.advanceTimersByTime(180_000);
    await settle();
    expect(isAccessTokenRevoked).toHaveBeenCalledTimes(1);
    answer(true);
    await settle();
    expect(stream!.closed).toBe(true);
  });

  it('a stream that closed early leaves no timers behind', async () => {
    const r = rig();
    const { res } = await r.connect(aUser({ expiresAt: T0 / 1000 + 900 }));
    res.disconnect();
    expect(jest.getTimerCount()).toBe(0);
  });
});
