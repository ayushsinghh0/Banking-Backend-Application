import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '@banksphere/common';
import { PAYMENT_STATUSES } from '../domain/status';
import { addDays, istDayStart } from '../domain/time';
import { toTopUpView } from '../domain/view';
import { PaymentErrors } from '../errors';
import { AdminService } from '../services/admin.service';
import { Reconciler } from '../services/reconciler';
import { RefundService } from '../services/refund.service';
import { TopUpService } from '../services/topup.service';
import { WebhookService } from '../services/webhook.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const PAISE = /^[1-9]\d{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({ accountId: z.string().regex(UUID, 'accountId must be an account id'), amountPaise: z.unknown() }).strict();
const confirmSchema = z
  .object({
    razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{1,40}$/),
    razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{1,40}$/),
    // Any length is accepted here so that a wrong one is reported (and logged) as an invalid signature
    razorpaySignature: z.string().min(1).max(256),
  })
  .strict();
const simulateSchema = z.object({ outcome: z.enum(['success', 'failure']), method: z.enum(['upi', 'card', 'netbanking']) }).strict();
const refundSchema = z.object({ reason: z.string().trim().min(10).max(300) }).strict();
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
const cursorSchema = z.string().min(1).max(200).optional();
const listSchema = z.object({ limit: limitSchema, cursor: cursorSchema });
const adminListSchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  customerId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

function topUpId(req: Request): string {
  const id = req.params.id;
  if (!UUID.test(id ?? '')) throw PaymentErrors.topUpNotFound();
  return id;
}

function idempotencyKey(req: Request, required: true): string;
function idempotencyKey(req: Request, required: false): string | undefined;
function idempotencyKey(req: Request, required: boolean): string | undefined {
  const key = req.header('idempotency-key');
  if (key === undefined && !required) return undefined;
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw PaymentErrors.idempotencyKeyRequired();
  return key;
}

function day(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const start = istDayStart(value);
  if (!start) throw new z.ZodError([{ code: 'custom', path: [field], message: 'Expected a calendar date (YYYY-MM-DD)', input: value }]);
  return start;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): Handler =>
  async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };

export class PaymentController {
  constructor(
    private readonly topUps: TopUpService,
    private readonly refunds: RefundService,
    private readonly admin: AdminService,
    private readonly reconciler: Reconciler
  ) {}

  public config = handle(async (req, res) => {
    res.json({ success: true, data: await this.topUps.getConfig(getAuthenticatedUser(req)) });
  });

  public createTopUp = handle(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const key = idempotencyKey(req, true);
    const body = createSchema.parse(req.body);
    if (typeof body.amountPaise !== 'string' || !PAISE.test(body.amountPaise)) throw PaymentErrors.invalidAmount();
    const result = await this.topUps.create(user, key, { accountId: body.accountId, amountPaise: BigInt(body.amountPaise) }, req);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(201).json({ success: true, data: { topUp: toTopUpView(result.topUp), checkout: result.checkout } });
  });

  public confirm = handle(async (req, res) => {
    const id = topUpId(req);
    const proof = confirmSchema.parse(req.body);
    const topUp = await this.topUps.confirm(getAuthenticatedUser(req), id, proof, req);
    res.json({ success: true, data: { topUp: toTopUpView(topUp) } });
  });

  public cancel = handle(async (req, res) => {
    const topUp = await this.topUps.cancel(getAuthenticatedUser(req), topUpId(req), req);
    res.json({ success: true, data: { topUp: toTopUpView(topUp) } });
  });

  public simulate = handle(async (req, res) => {
    const id = topUpId(req);
    const input = simulateSchema.parse(req.body);
    res.json({ success: true, data: await this.topUps.simulate(getAuthenticatedUser(req), id, input) });
  });

  public list = handle(async (req, res) => {
    const { limit, cursor } = listSchema.parse(req.query);
    const page = await this.topUps.list(getAuthenticatedUser(req), limit, cursor);
    res.json({ success: true, data: { items: page.items.map((t) => toTopUpView(t)), nextCursor: page.nextCursor } });
  });

  public get = handle(async (req, res) => {
    const { topUp, history, staff } = await this.topUps.get(getAuthenticatedUser(req), topUpId(req));
    res.json({ success: true, data: { topUp: toTopUpView(topUp, { history, staff }) } });
  });

  public adminList = handle(async (req, res) => {
    const q = adminListSchema.parse(req.query);
    const to = day(q.to, 'to');
    const page = await this.admin.list(
      { status: q.status, customerId: q.customerId, createdFrom: day(q.from, 'from'), createdBefore: to ? addDays(to, 1) : undefined },
      { limit: q.limit, cursor: q.cursor }
    );
    res.json({ success: true, data: { items: page.items.map((t) => toTopUpView(t, { staff: true })), nextCursor: page.nextCursor } });
  });

  public summary = handle(async (_req, res) => {
    res.json({ success: true, data: await this.admin.summary() });
  });

  public refund = handle(async (req, res) => {
    const admin = getAuthenticatedUser(req);
    const id = topUpId(req);
    const key = idempotencyKey(req, false);
    const { reason } = refundSchema.parse(req.body);
    const outcome = await this.refunds.refund(admin, id, reason, key, req.correlationId);
    // 202: accepted and in flight (Razorpay pending, or a dependency is down and the reconciler resumes it)
    res.status(outcome.settled ? 200 : 202).json({ success: true, data: { topUp: toTopUpView(outcome.topUp, { staff: true }) } });
  });

  public reconcile = handle(async (req, res) => {
    res.json({ success: true, data: await this.reconciler.runNow(getAuthenticatedUser(req).id) });
  });
}

export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  public razorpay = handle(async (req, res) => {
    const status = await this.webhooks.handle({
      rawBody: req.rawBody,
      body: req.body,
      signature: req.header('x-razorpay-signature'),
      eventId: req.header('x-razorpay-event-id'),
      ip: req.ip,
      correlationId: req.correlationId,
    });
    res.json({ success: true, data: { status } });
  });
}
