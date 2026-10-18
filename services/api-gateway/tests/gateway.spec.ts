import http from 'http';
import express from 'express';
import request from 'supertest';
import { AddressInfo } from 'net';
import { createGateway } from '../src/app';

describe('API Gateway', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.all('*', (req, res) => {
      seen.push({ url: req.originalUrl, headers: req.headers, body: req.body });
      res.json({ ok: true, url: req.originalUrl });
    });
    upstream = app.listen(0);
    await new Promise((r) => upstream.once('listening', r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(() => upstream.close());
  beforeEach(() => (seen.length = 0));

  const gateway = () =>
    createGateway({
      routes: [{ name: 'transaction-service', prefix: '/api/v1/transactions', target: upstreamUrl }],
      corsOrigins: ['https://app.example.com'],
    });

  it('proxies public routes with the full path and body', async () => {
    const res = await request(gateway())
      .post('/api/v1/transactions/transfer')
      .send({ amountInPaise: '100' });
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe('/api/v1/transactions/transfer');
    expect(seen[0].body).toEqual({ amountInPaise: '100' });
  });

  it('never exposes internal service routes', async () => {
    const res = await request(gateway()).post('/internal/v1/ledger-accounts').send({});
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('does not match look-alike prefixes', async () => {
    const res = await request(gateway()).get('/api/v1/transactionsX/whatever');
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('strips spoofable identity and internal-token headers before forwarding', async () => {
    await request(gateway())
      .get('/api/v1/transactions/accounts/x/balance')
      .set('x-internal-service-token', 'guess')
      .set('x-user-id', 'victim')
      .set('x-user-role', 'BANK_ADMIN')
      .set('authorization', 'Bearer abc');
    const headers = seen[0].headers;
    expect(headers['x-internal-service-token']).toBeUndefined();
    expect(headers['x-user-id']).toBeUndefined();
    expect(headers['x-user-role']).toBeUndefined();
    expect(headers['authorization']).toBe('Bearer abc');
    expect(headers['x-correlation-id']).toBeDefined();
  });

  it('IP SPOOFING: a client-supplied X-Forwarded-For is replaced by the real client address', async () => {
    await request(gateway())
      .get('/api/v1/transactions/accounts/x/balance')
      .set('x-forwarded-for', '6.6.6.6')
      .set('forwarded', 'for=6.6.6.6')
      .set('x-real-ip', '6.6.6.6');
    const headers = seen[0].headers;
    expect(headers['x-forwarded-for']).not.toContain('6.6.6.6');
    expect(headers['forwarded']).toBeUndefined();
    expect(headers['x-real-ip']).toBeUndefined();
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await request(gateway())
      .options('/api/v1/transactions/transfer')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

    const denied = await request(gateway())
      .options('/api/v1/transactions/transfer')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('STAFF NETWORK: staff-only paths are refused from outside STAFF_ALLOWED_CIDRS', async () => {
    process.env.STAFF_ALLOWED_CIDRS = '10.20.0.0/16';
    try {
      const app = createGateway({
        routes: [{ name: 'transaction-service', prefix: '/api/v1/transactions', target: upstreamUrl }],
      });
      const staff = await request(app).post('/api/v1/transactions/deposit').send({});
      expect(staff.status).toBe(403);
      expect(staff.body.error.code).toBe('NETWORK_NOT_ALLOWED');
      const customer = await request(app).post('/api/v1/transactions/transfer').send({});
      expect(customer.status).toBe(200);
      // Upstream routing is case-insensitive and tolerant: none of these spellings may slip past the check
      for (const sneaky of ['/api/v1/transactions/Deposit', '/api/v1/TRANSACTIONS/deposit', '/api/v1/transactions/%64eposit', '/api/v1/transactions//deposit', '/api/v1/transactions/deposit/']) {
        const res = await request(app).post(sneaky).send({});
        expect([sneaky, res.status]).toEqual([sneaky, 403]);
      }
      expect((await request(app).post('/api/v1/transactions/%E0%A4%A').send({})).status).toBe(400);
    } finally {
      delete process.env.STAFF_ALLOWED_CIDRS;
    }
  });

  it('returns 502 JSON when an upstream is down', async () => {
    const app = createGateway({
      routes: [{ name: 'auth-service', prefix: '/api/v1/auth', target: 'http://127.0.0.1:1' }],
    });
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BAD_GATEWAY');
  });
});
