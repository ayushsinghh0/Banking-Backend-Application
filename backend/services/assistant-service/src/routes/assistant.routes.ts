import { RequestHandler, Router } from 'express';
import { authorize } from '@banksphere/common';

export interface AssistantRoutes {
  getMeta: RequestHandler;
  listConversations: RequestHandler;
  createConversation: RequestHandler;
  getConversation: RequestHandler;
  deleteConversation: RequestHandler;
  postMessage: RequestHandler;
}

/**
 * Mounted at /api/v1/assistant. Every route needs assistant:chat (every role); the controller then scopes every
 * conversation to its owner, so a permission alone never reaches anyone else's thread.
 */
export function createAssistantRouter(controller: AssistantRoutes, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/meta', authorize('assistant:chat'), controller.getMeta);
  router.get('/conversations', authorize('assistant:chat'), controller.listConversations);
  router.post('/conversations', authorize('assistant:chat'), controller.createConversation);
  router.get('/conversations/:id', authorize('assistant:chat'), controller.getConversation);
  router.delete('/conversations/:id', authorize('assistant:chat'), controller.deleteConversation);
  router.post('/conversations/:id/messages', authorize('assistant:chat'), controller.postMessage);

  return router;
}
