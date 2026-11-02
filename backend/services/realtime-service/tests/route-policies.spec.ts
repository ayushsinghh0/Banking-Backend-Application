/**
 * Every route carries an explicit authorization policy that matches the declared access table
 * (src/routes/access.ts), so adding a route or loosening one fails the build.
 */
import { RequestHandler } from 'express';
import { assertRoutePolicies, describeRoutes, stubController } from '@banksphere/common';
import { REALTIME_ACCESS } from '../src/routes/access';
import { createRealtimeRouter, RealtimeController } from '../src/routes/realtime.routes';

const authenticate: RequestHandler = (_req, _res, next) => next();

describe('real-time route policies', () => {
  const router = createRealtimeRouter(stubController<RealtimeController>(), authenticate);

  it('match the access table exactly', () => {
    expect(() => assertRoutePolicies(router, REALTIME_ACCESS, 'realtime router')).not.toThrow();
  });

  it('the stream is authorized by the realtime:subscribe permission (every role), never public', () => {
    const [route] = describeRoutes(router);
    expect(route.policies).toEqual([expect.objectContaining({ kind: 'permission', permissions: ['realtime:subscribe'] })]);
    expect(route.effective).toEqual(['CUSTOMER', 'SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN']);
  });

  it('a route added without updating the table is caught', () => {
    router.get('/debug', authenticate, (_req, res) => res.end());
    expect(() => assertRoutePolicies(router, REALTIME_ACCESS)).toThrow(/GET \/debug: no authorization policy/);
  });
});
