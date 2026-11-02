/**
 * RealtimeStore: key and channel names, script arguments, and reading the replay log.
 */
import { DEDUPE_WINDOW, RealtimeRedisClient, RealtimeStore } from '../src/redis/realtime-store';
import { compareStreamIds, isStreamId } from '../src/redis/envelope';
import { RealtimeEventBody } from '../src/events/types';

const event: RealtimeEventBody = { type: 'account.status', at: '2026-10-28T10:00:00.000Z', data: { accountId: 'a', status: 'FROZEN' } };

function mockClient(overrides: Partial<RealtimeRedisClient> = {}) {
  const pipelineOps: unknown[][] = [];
  const client = {
    rtDeliver: jest.fn().mockResolvedValue(['1790000000000-0', 0]),
    rtAdmit: jest.fn().mockResolvedValue(1),
    xrevrange: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1),
    zrem: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    pipeline: jest.fn(() => {
      const p = {
        zadd: (...args: unknown[]) => (pipelineOps.push(['zadd', ...args]), p),
        expire: (...args: unknown[]) => (pipelineOps.push(['expire', ...args]), p),
        exec: jest.fn().mockResolvedValue([]),
      };
      return p;
    }),
    ...overrides,
  };
  return { client, pipelineOps };
}

describe('RealtimeStore', () => {
  it('deliverToUser: one script call with the log key, the channel, MAXLEN 100, 24 h TTL, the event without id and its dedupe key', async () => {
    const { client } = mockClient();
    const store = new RealtimeStore(client as unknown as RealtimeRedisClient);
    expect(await store.deliverToUser('cust-1', event, 'evt-1')).toEqual({ id: '1790000000000-0', duplicate: false });
    expect(client.rtDeliver).toHaveBeenCalledWith(
      'rt:log:user:cust-1',
      'rt:user:cust-1',
      100,
      86_400,
      '{"type":"account.status","at":"2026-10-28T10:00:00.000Z","data":{"accountId":"a","status":"FROZEN"}}',
      'evt-1',
      DEDUPE_WINDOW
    );
    (client.rtDeliver as jest.Mock).mockResolvedValueOnce(['1790000000000-0', 1]);
    expect((await store.deliverToUser('cust-1', event, 'evt-1')).duplicate).toBe(true);
  });

  it('publishToRole: PUBLISH only, on rt:role:<ROLE>', async () => {
    const { client } = mockClient();
    await new RealtimeStore(client as unknown as RealtimeRedisClient).publishToRole('SUPPORT', { id: 'r-1', ...event });
    expect(client.publish).toHaveBeenCalledWith('rt:role:SUPPORT', JSON.stringify({ id: 'r-1', ...event }));
  });

  it('readSince: XREVRANGE with an EXCLUSIVE start, newest `limit`, returned oldest first; unreadable entries skipped', async () => {
    const stored = JSON.stringify(event);
    const { client } = mockClient({
      xrevrange: jest.fn().mockResolvedValue([
        ['5-0', ['e', stored, 'k', 'evt-5']],
        ['4-0', ['e', '{broken', 'k', 'evt-4']],
        ['3-0', ['k', 'evt-3', 'e', stored]],
        ['2-0', ['e', JSON.stringify({ type: 'x\ny', at: 'a', data: {} }), 'k', 'evt-2']],
      ]),
    });
    const events = await new RealtimeStore(client as unknown as RealtimeRedisClient).readSince('cust-1', '1-0', 100);
    expect(client.xrevrange).toHaveBeenCalledWith('rt:log:user:cust-1', '+', '(1-0', 'COUNT', 100);
    expect(events).toEqual([
      { id: '3-0', ...event },
      { id: '5-0', ...event },
    ]);
  });

  it('admit / refresh / release use the per-user registry with the stale window', async () => {
    const { client, pipelineOps } = mockClient();
    const store = new RealtimeStore(client as unknown as RealtimeRedisClient);
    expect(await store.admit({ userId: 'cust-1', connectionId: 'c1' }, { limit: 5, staleAfterMs: 60_000 }, 1_000_000)).toBe(true);
    expect(client.rtAdmit).toHaveBeenCalledWith('rt:streams:user:cust-1', 1_000_000, 940_000, 5, 'c1', 120);
    (client.rtAdmit as jest.Mock).mockResolvedValueOnce(0);
    expect(await store.admit({ userId: 'cust-1', connectionId: 'c2' }, { limit: 5, staleAfterMs: 60_000 })).toBe(false);

    await store.refresh([{ userId: 'cust-1', connectionId: 'c1' }, { userId: 'cust-2', connectionId: 'c9' }], 60_000, 2_000_000);
    expect(pipelineOps).toEqual([
      ['zadd', 'rt:streams:user:cust-1', 2_000_000, 'c1'],
      ['expire', 'rt:streams:user:cust-1', 120],
      ['zadd', 'rt:streams:user:cust-2', 2_000_000, 'c9'],
      ['expire', 'rt:streams:user:cust-2', 120],
    ]);
    await store.refresh([], 60_000);
    expect(client.pipeline).toHaveBeenCalledTimes(1);

    await store.release({ userId: 'cust-1', connectionId: 'c1' });
    expect(client.zrem).toHaveBeenCalledWith('rt:streams:user:cust-1', 'c1');
  });

  it('refresh surfaces a failed pipeline command', async () => {
    const { client } = mockClient({
      pipeline: jest.fn(() => ({ zadd: jest.fn(), expire: jest.fn(), exec: jest.fn().mockResolvedValue([[new Error('NOPERM'), null]]) })) as any,
    });
    await expect(new RealtimeStore(client as unknown as RealtimeRedisClient).refresh([{ userId: 'u', connectionId: 'c' }], 60_000)).rejects.toThrow('NOPERM');
  });
});

describe('stream ids', () => {
  it('validates and orders "<ms>-<seq>" ids numerically (not as strings)', () => {
    expect(isStreamId('1790000000000-0')).toBe(true);
    expect(['', '1-', '-1', '1-2-3', 'a-1', '1790000000000-0\n', 5].map(isStreamId)).toEqual([false, false, false, false, false, false, false]);
    expect(compareStreamIds('9-0', '10-0')).toBeLessThan(0);
    expect(compareStreamIds('10-2', '10-10')).toBeLessThan(0);
    expect(compareStreamIds('10-1', '10-1')).toBe(0);
    expect(compareStreamIds('1790000000001-0', '1790000000000-99')).toBeGreaterThan(0);
  });
});
