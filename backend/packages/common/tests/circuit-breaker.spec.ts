import { CircuitBreaker, CircuitOpenError, retry } from '../src';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function breaker(time = clock()) {
  return {
    time,
    cb: new CircuitBreaker({ name: 'ledger', windowMs: 10_000, minimumRequests: 4, failureRatio: 0.5, cooldownMs: 5_000, halfOpenProbes: 2, now: time.now }),
  };
}

const call = (cb: CircuitBreaker, success: boolean) => {
  const done = cb.acquire();
  if (!done) return false;
  done(success);
  return true;
};

describe('CircuitBreaker', () => {
  it('stays closed while there are too few calls to judge, however many fail', () => {
    const { cb } = breaker();
    for (let i = 0; i < 3; i++) call(cb, false);
    expect(cb.state).toBe('closed');
  });

  it('opens when the failure ratio reaches the threshold over the minimum volume, then refuses calls', () => {
    const { cb } = breaker();
    call(cb, true);
    call(cb, true);
    call(cb, false);
    expect(cb.state).toBe('closed');
    call(cb, false);
    expect(cb.state).toBe('open');
    expect(cb.acquire()).toBeNull();
  });

  it('forgets failures that have left the rolling window', () => {
    const { cb, time } = breaker();
    call(cb, false);
    call(cb, false);
    call(cb, false);
    time.advance(11_000);
    call(cb, true);
    call(cb, true);
    call(cb, true);
    call(cb, false);
    expect(cb.state).toBe('closed');
  });

  it('lets a limited number of probes through after the cooldown and closes when they all succeed', () => {
    const { cb, time } = breaker();
    for (let i = 0; i < 4; i++) call(cb, false);
    time.advance(5_000);
    expect(cb.state).toBe('half-open');
    const probe1 = cb.acquire();
    const probe2 = cb.acquire();
    expect(probe1).not.toBeNull();
    expect(probe2).not.toBeNull();
    expect(cb.acquire()).toBeNull(); // only two probes at a time
    probe1!(true);
    expect(cb.state).toBe('half-open');
    probe2!(true);
    expect(cb.state).toBe('closed');
  });

  it('re-opens on a failed probe', () => {
    const { cb, time } = breaker();
    for (let i = 0; i < 4; i++) call(cb, false);
    time.advance(5_000);
    call(cb, false);
    expect(cb.state).toBe('open');
  });

  it('ignores the outcome of calls that started before the state changed', () => {
    const { cb, time } = breaker();
    const slow = cb.acquire();
    for (let i = 0; i < 4; i++) call(cb, false);
    time.advance(5_000);
    expect(cb.state).toBe('half-open');
    slow!(false); // started while closed: must not re-open the half-open breaker
    expect(cb.state).toBe('half-open');
  });

  it('execute() refuses with a 503 error while open and counts only failures the caller classifies', async () => {
    const { cb } = breaker();
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    for (let i = 0; i < 6; i++) {
      await expect(cb.execute(() => Promise.reject(notFound), (e) => (e as { status: number }).status >= 500)).rejects.toBe(notFound);
    }
    expect(cb.state).toBe('closed');
    for (let i = 0; i < 6; i++) await cb.execute(() => Promise.reject(new Error('down'))).catch(() => undefined);
    await expect(cb.execute(async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('retry', () => {
  it('retries up to the attempt limit with jittered, capped exponential delays', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error('busy');
        },
        { attempts: 4, baseMs: 100, maxMs: 300, random: () => 0.999, sleep: async (ms) => void delays.push(ms) }
      )
    ).rejects.toThrow('busy');
    expect(calls).toBe(4);
    expect(delays).toEqual([99, 199, 299]);
  });

  it('stops at once when retryOn says the error is permanent, and returns the first success', async () => {
    let calls = 0;
    await expect(retry(async () => { calls += 1; throw new Error('bad request'); }, { retryOn: () => false })).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(retry(async (attempt) => (attempt < 1 ? Promise.reject(new Error('x')) : 'ok'), { sleep: async () => {} })).resolves.toBe('ok');
  });

  it('never starts an attempt after the deadline', async () => {
    let calls = 0;
    await expect(
      retry(async () => { calls += 1; throw new Error('slow'); }, { attempts: 5, baseMs: 1_000, random: () => 1, deadline: Date.now() + 500, sleep: async () => {} })
    ).rejects.toThrow('slow');
    expect(calls).toBe(1);
  });
});
