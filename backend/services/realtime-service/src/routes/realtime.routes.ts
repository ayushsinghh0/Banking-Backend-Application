import { RequestHandler, Router } from 'express';
import { authorize } from '@banksphere/common';

export interface RealtimeController {
  stream: RequestHandler;
}

/** Mounted at /api/v1/realtime */
export function createRealtimeRouter(controller: RealtimeController, authenticate: RequestHandler): Router {
  const router = Router();
  router.get('/stream', authenticate, authorize('realtime:subscribe'), controller.stream);
  return router;
}
