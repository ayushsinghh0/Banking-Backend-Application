import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { errorHandlerMiddleware } from '@banksphere/common';
import { createFraudRouter } from '../src/routes/fraud.routes';
import { FraudController } from '../src/controllers/fraud.controller';

describe('fraud routes: who may do what', () => {
  const alertId = '6f1c3d52-8a3e-4f0a-9d0c-2b7e5c1a9f10';
  let fraudService: any;
  let app: express.Express;

  // Stand-in for JWT authentication: the role comes from a test header
  const fakeAuthenticate = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: `user-${req.header('x-test-role')}`, email: 'staff@bank.com', role: req.header('x-test-role'), mfa: true };
    next();
  };

  beforeEach(() => {
    fraudService = {
      getAlerts: jest.fn().mockResolvedValue([]),
      getAlertHistory: jest.fn().mockResolvedValue([]),
      updateAlertStatus: jest.fn().mockResolvedValue({ id: alertId, status: 'UNDER_REVIEW', pendingSecondApproval: true }),
      previewTransaction: jest.fn(),
    };
    app = express();
    app.use(express.json());
    app.use('/api/v1/fraud', createFraudRouter(new FraudController(fraudService), fakeAuthenticate));
    app.use(errorHandlerMiddleware);
  });

  it.each(['BANK_ADMIN', 'SUPPORT', 'TELLER', 'CUSTOMER'])('SEPARATION OF DUTIES: %s cannot triage an alert (403)', async (role) => {
    const res = await request(app).patch(`/api/v1/fraud/alerts/${alertId}`).set('x-test-role', role).send({ status: 'DISMISSED' });
    expect(res.status).toBe(403);
    expect(fraudService.updateAlertStatus).not.toHaveBeenCalled();
  });

  it('a FRAUD_ANALYST triages alerts', async () => {
    const res = await request(app).patch(`/api/v1/fraud/alerts/${alertId}`).set('x-test-role', 'FRAUD_ANALYST').send({ status: 'DISMISSED' });
    expect(res.status).toBe(200);
    expect(fraudService.updateAlertStatus).toHaveBeenCalled();
  });

  it.each(['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'])('%s can read alerts and their history', async (role) => {
    expect((await request(app).get('/api/v1/fraud/alerts').set('x-test-role', role)).status).toBe(200);
    expect((await request(app).get(`/api/v1/fraud/alerts/${alertId}/history`).set('x-test-role', role)).status).toBe(200);
  });
});
