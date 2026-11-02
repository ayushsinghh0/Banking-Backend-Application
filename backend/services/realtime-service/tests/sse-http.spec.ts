/**
 * The stream over a real HTTP server and fetch: authentication with real ES256 tokens, SSE framing,
 * Last-Event-ID replay, the per-user limit, staff network/MFA rules, and cleanup when the client leaves.
 */
import { RealtimeEventBody } from '../src/events/types';
import { HttpRig, startHttpRig, tokenFor } from './support/http-app';
import { openSse } from './support/sse-client';
import { settle } from './support/fake-redis';

const posted: RealtimeEventBody = {
  type: 'transaction.posted',
  at: '2026-10-28T10:00:00.000Z',
  data: { transactionId: 'tx-1', type: 'TRANSFER', amountInPaise: '250000', accountId: 'acc-1', direction: 'CREDIT' },
};

describe('GET /api/v1/realtime/stream over HTTP', () => {
  let rig: HttpRig;
  const open: Array<{ close(): void }> = [];

  beforeEach(async () => {
    rig = await startHttpRig({ heartbeatSeconds: 1 });
  });
  afterEach(async () => {
    open.splice(0).forEach((s) => s.close());
    await rig.stop();
  });

  const stream = async (token: string, headers: Record<string, string> = {}) => {
    const s = await openSse(`${rig.url}/api/v1/realtime/stream`, { authorization: `Bearer ${token}`, ...headers });
    open.push(s);
    return s;
  };

  it('401 without a token, and with a token that is not ours', async () => {
    const none = await fetch(`${rig.url}/api/v1/realtime/stream`);
    expect(none.status).toBe(401);
    expect((await none.json()).error.code).toBe('UNAUTHORIZED');
    const forged = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' } });
    expect(forged.status).toBe(401);
  });

  it('SSE FRAMING: streaming headers, `ready` first, then `{ id, type, at, data }` events whose SSE id is the stream id', async () => {
    const s = await stream(tokenFor('cust-1'));
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(s.res.headers.get('cache-control')).toContain('no-transform');
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');

    const ready = await s.waitFor((f) => f.event === 'ready');
    expect(s.frames[0]).toBe(ready);
    expect(ready.raw).toMatch(/^event: ready\ndata: \{"connectionId":"[0-9a-f-]{36}","heartbeatSeconds":1\}\n\n$/);

    const { id } = await rig.store.deliverToUser('cust-1', posted, 'evt-1:credit');
    const frame = await s.waitFor((f) => f.event === 'transaction.posted');
    expect(frame.raw).toBe(
      `id: ${id}\nevent: transaction.posted\ndata: {"id":"${id}","type":"transaction.posted","at":"2026-10-28T10:00:00.000Z","data":{"transactionId":"tx-1","type":"TRANSFER","amountInPaise":"250000","accountId":"acc-1","direction":"CREDIT"}}\n\n`
    );
  });

  it('sends comment heartbeats', async () => {
    const s = await stream(tokenFor('cust-1'));
    await s.waitFor((f) => f.comment === 'keep-alive', 3_000);
  });

  it('Last-Event-ID (header) replays only what was missed, then continues live', async () => {
    const first = await rig.store.deliverToUser('cust-1', posted, 'e1');
    const second = await rig.store.deliverToUser('cust-1', { ...posted, data: { ...posted.data, transactionId: 'tx-2' } }, 'e2');
    const s = await stream(tokenFor('cust-1'), { 'Last-Event-ID': first.id });
    const replayed = await s.waitFor((f) => f.event === 'transaction.posted');
    expect(replayed.id).toBe(second.id);
    const third = await rig.store.deliverToUser('cust-1', { ...posted, data: { ...posted.data, transactionId: 'tx-3' } }, 'e3');
    await s.waitFor((f) => f.id === third.id);
    expect(s.frames.filter((f) => f.event === 'transaction.posted').map((f) => f.id)).toEqual([second.id, third.id]);
  });

  it('the 6th concurrent stream of a user is refused with 429 TOO_MANY_STREAMS and Retry-After', async () => {
    const token = tokenFor('cust-1');
    for (let i = 0; i < 5; i++) await (await stream(token)).waitFor((f) => f.event === 'ready');
    const res = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect((await res.json()).error.code).toBe('TOO_MANY_STREAMS');
  });

  it('a revoked token is refused before any stream opens', async () => {
    await rig.tokenState.revokeSession('sid-cust-1');
    const res = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${tokenFor('cust-1')}` } });
    expect(res.status).toBe(401);
  });

  it('staff without MFA are refused (403 MFA_REQUIRED); with MFA they get their role channel', async () => {
    const noMfa = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${tokenFor('admin-1', 'BANK_ADMIN', { mfa: false })}` } });
    expect(noMfa.status).toBe(403);
    expect((await noMfa.json()).error.code).toBe('MFA_REQUIRED');

    const s = await stream(tokenFor('admin-1', 'BANK_ADMIN'));
    await s.waitFor((f) => f.event === 'ready');
    await rig.store.publishToRole('BANK_ADMIN', { id: 'r-evt-1', ...posted, type: 'payment.updated', data: { topUpId: 't', status: 'CREDITED', amountInPaise: '1', accountId: 'a' } });
    const frame = await s.waitFor((f) => f.event === 'payment.updated');
    expect(frame.id).toBeUndefined(); // role events never move the client's Last-Event-ID
  });

  it('when the client leaves, its subscription and registry entry go too', async () => {
    const s = await stream(tokenFor('cust-1'));
    await s.waitFor((f) => f.event === 'ready');
    expect(rig.subscriber.channels.has('rt:user:cust-1')).toBe(true);
    s.close();
    for (let i = 0; i < 100 && rig.app.streams.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
    await settle();
    expect(rig.app.streams.size).toBe(0);
    expect(rig.subscriber.channels.size).toBe(0);
    expect(rig.redis.zsets.get('rt:streams:user:cust-1')!.size).toBe(0);
  });

  it('unknown routes are 404 JSON, never a stream', async () => {
    const res = await fetch(`${rig.url}/api/v1/realtime/other`, { headers: { authorization: `Bearer ${tokenFor('cust-1')}` } });
    expect(res.status).toBe(404);
  });
});

describe('staff network rule (STAFF_ALLOWED_CIDRS)', () => {
  let rig: HttpRig;
  beforeAll(async () => {
    process.env.STAFF_ALLOWED_CIDRS = '10.0.0.0/8';
    rig = await startHttpRig();
  });
  afterAll(async () => {
    delete process.env.STAFF_ALLOWED_CIDRS;
    await rig.stop();
  });

  it('a staff token from outside the staff network gets 403; a customer from the same address is served', async () => {
    const staff = await fetch(`${rig.url}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${tokenFor('fa-1', 'FRAUD_ANALYST')}` } });
    expect(staff.status).toBe(403);
    expect((await staff.json()).error.code).toBe('NETWORK_NOT_ALLOWED');

    const s = await openSse(`${rig.url}/api/v1/realtime/stream`, { authorization: `Bearer ${tokenFor('cust-1')}` });
    expect(s.res.status).toBe(200);
    s.close();
  });
});
