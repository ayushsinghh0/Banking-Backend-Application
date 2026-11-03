import express, { RequestHandler } from 'express';
import request from 'supertest';
import { AuthenticatedUser, errorHandlerMiddleware } from '@banksphere/common';
import { createTransactionRouter } from '../src/routes/transaction.routes';
import { TransactionController } from '../src/controllers/transaction.controller';

const users: Record<string, AuthenticatedUser> = {
  teller: { id: 'teller', email: 'teller@bank.com', role: 'TELLER', mfa: true },
  admin: { id: 'admin', email: 'admin@bank.com', role: 'BANK_ADMIN', mfa: true },
  support: { id: 'support', email: 'support@bank.com', role: 'SUPPORT', mfa: true },
  alice: { id: 'alice', email: 'alice@bank.com', role: 'CUSTOMER' },
};

function appWith(tellerService: any) {
  // Stand-in for the JWT middleware: the test names the caller in a header
  const authenticate: RequestHandler = (req, _res, next) => {
    req.user = users[String(req.headers['x-test-user'])];
    next();
  };
  const controller = new TransactionController({} as any, tellerService, {} as any, {} as any);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', createTransactionRouter(controller, authenticate));
  app.use(errorHandlerMiddleware);
  return app;
}

describe('Transaction routes', () => {
  it("GET /teller/sessions/current returns the teller's own session (or null), for tellers only", async () => {
    const view = { id: 'sess-1', tellerId: 'teller', status: 'ISSUED', openingFloat: null };
    const tellerService = { currentSession: jest.fn().mockResolvedValueOnce(view).mockResolvedValueOnce(null) };
    const app = appWith(tellerService);

    const res = await request(app).get('/api/v1/transactions/teller/sessions/current').set('x-test-user', 'teller');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: view });
    expect(tellerService.currentSession).toHaveBeenCalledWith(users.teller);
    const none = await request(app).get('/api/v1/transactions/teller/sessions/current').set('x-test-user', 'teller');
    expect(none.body).toEqual({ success: true, data: null });

    for (const who of ['admin', 'support', 'alice']) {
      expect((await request(app).get('/api/v1/transactions/teller/sessions/current').set('x-test-user', who)).status).toBe(403);
    }
    expect(tellerService.currentSession).toHaveBeenCalledTimes(2);
  });

  it('GET /cash-operations passes the caller, so a teller is scoped to their own requests', async () => {
    const tellerService = { listCashOperations: jest.fn().mockResolvedValue([]) };
    const app = appWith(tellerService);
    const res = await request(app).get('/api/v1/transactions/cash-operations?status=EXECUTED').set('x-test-user', 'teller');
    expect(res.status).toBe(200);
    expect(tellerService.listCashOperations).toHaveBeenCalledWith('EXECUTED', 20, 0, users.teller);
  });
});
