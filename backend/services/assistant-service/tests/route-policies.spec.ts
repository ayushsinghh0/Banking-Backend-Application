/**
 * Every assistant route carries an explicit authorization policy that matches the declared access table
 * (src/routes/access.ts), so adding a route or loosening one fails the build.
 */
import { RequestHandler } from 'express';
import { assertRoutePolicies, describeRoutes, stubController } from '@banksphere/common';
import { ASSISTANT_ACCESS } from '../src/routes/access';
import { AssistantRoutes, createAssistantRouter } from '../src/routes/assistant.routes';

const passThrough: RequestHandler = (_req, _res, next) => next();

describe('assistant route policies', () => {
  it('match the access table exactly', () => {
    expect(() => assertRoutePolicies(createAssistantRouter(stubController<AssistantRoutes>(), passThrough), ASSISTANT_ACCESS, 'assistant router')).not.toThrow();
  });

  it('every route is authorized by assistant:chat, nothing is public', () => {
    for (const route of describeRoutes(createAssistantRouter(stubController<AssistantRoutes>(), passThrough))) {
      expect([route.method, route.path, route.policies]).toEqual([
        route.method,
        route.path,
        [expect.objectContaining({ kind: 'permission', permissions: ['assistant:chat'] })],
      ]);
    }
  });

  it('a route added without updating the table is caught', () => {
    const router = createAssistantRouter(stubController<AssistantRoutes>(), passThrough);
    router.get('/export', passThrough);
    expect(() => assertRoutePolicies(router, ASSISTANT_ACCESS)).toThrow(/GET \/export: no authorization policy/);
  });
});
