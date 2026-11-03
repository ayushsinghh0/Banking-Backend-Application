import {
  PAYMENT_STATUSES,
  PaymentStatus,
  assertTransition,
  canTransition,
  sourcesOf,
  OPEN_STATUSES,
  LATE_CAPTURE_STATUSES,
} from '../src/domain/status';

/** The design's state diagram (section 6), written out edge by edge. Anything not listed must be refused. */
const ALLOWED: Array<[PaymentStatus, PaymentStatus]> = [
  ['CREATED', 'PENDING'],
  ['CREATED', 'CAPTURED'],
  ['CREATED', 'CANCELLED'],
  ['CREATED', 'FAILED'],
  ['CREATED', 'EXPIRED'],
  ['PENDING', 'CAPTURED'],
  ['PENDING', 'CANCELLED'],
  ['PENDING', 'FAILED'],
  ['PENDING', 'EXPIRED'],
  ['CAPTURED', 'CREDITED'],
  ['CAPTURED', 'CREDIT_BLOCKED'],
  ['CREDITED', 'REFUND_PENDING'],
  ['CREDIT_BLOCKED', 'REFUND_PENDING'],
  ['REFUND_PENDING', 'REFUNDED'],
  ['REFUND_PENDING', 'CREDITED'], // refund failed, ledger debit compensated
  ['REFUND_PENDING', 'CREDIT_BLOCKED'], // refund of a blocked credit failed: nothing to compensate
  ['CANCELLED', 'CAPTURED'], // late capture still credits
  ['FAILED', 'CAPTURED'],
  ['EXPIRED', 'CAPTURED'],
];

describe('top-up state machine', () => {
  const allowed = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));

  it.each(PAYMENT_STATUSES.flatMap((from) => PAYMENT_STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s matches the design table',
    (from, to) => {
      expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
    }
  );

  it('never allows leaving REFUNDED or staying in place', () => {
    for (const to of PAYMENT_STATUSES) expect(canTransition('REFUNDED', to)).toBe(false);
    for (const s of PAYMENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('lists the legal predecessors of a status (the guard of the UPDATE)', () => {
    expect(sourcesOf('CAPTURED').sort()).toEqual(['CANCELLED', 'CREATED', 'EXPIRED', 'FAILED', 'PENDING']);
    expect(sourcesOf('CREDITED').sort()).toEqual(['CAPTURED', 'REFUND_PENDING']);
    expect(sourcesOf('REFUND_PENDING').sort()).toEqual(['CREDITED', 'CREDIT_BLOCKED']);
    expect(sourcesOf('CREATED')).toEqual([]);
  });

  it('refuses an illegal transition loudly (a programming error, never silently applied)', () => {
    expect(() => assertTransition('CREDITED', 'CAPTURED')).toThrow(/CREDITED -> CAPTURED/);
    expect(() => assertTransition('CREATED', 'CREDITED')).toThrow();
    expect(() => assertTransition('CAPTURED', 'CREDITED')).not.toThrow();
  });

  it('names the open and late-capture groups', () => {
    expect(OPEN_STATUSES).toEqual(['CREATED', 'PENDING']);
    expect([...LATE_CAPTURE_STATUSES].sort()).toEqual(['CANCELLED', 'EXPIRED', 'FAILED']);
  });
});
