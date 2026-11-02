import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '@banksphere/common';
import { SecurityEventType } from '../../generated/client';
import { AccountSecurityService } from '../services/account-security.service';
import { SECURITY_EVENT_TYPES } from '../services/security-events';
import { clientOf } from './client-context';

const uuid = z.string().uuid();
const sessionParams = z.object({ sessionId: uuid });
const userParams = z.object({ userId: uuid });
const userSessionParams = z.object({ userId: uuid, sessionId: uuid });
const ruleParams = z.object({ ruleId: uuid });
const banParams = z.object({ ipKey: z.string().min(1).max(64) });
const ownEventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const adminEventsQuery = z.object({
  type: z.enum(SECURITY_EVENT_TYPES as [SecurityEventType, ...SecurityEventType[]]).optional(),
  userId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
const newRuleSchema = z
  .object({
    cidr: z.string().trim().min(2).max(64),
    reason: z.string().max(400),
    expiresInMinutes: z.number().int().optional(),
  })
  .strict();

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export class SecurityController {
  constructor(private readonly security: AccountSecurityService) {}

  public listSessions = wrap(async (req, res) => {
    res.json({ success: true, data: await this.security.listOwnSessions(getAuthenticatedUser(req)) });
  });

  public revokeSession = wrap(async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    res.json({ success: true, data: await this.security.revokeOwnSession(getAuthenticatedUser(req), sessionId, clientOf(req)) });
  });

  public revokeOtherSessions = wrap(async (req, res) => {
    res.json({ success: true, data: await this.security.revokeOtherSessions(getAuthenticatedUser(req), clientOf(req)) });
  });

  public listSecurityEvents = wrap(async (req, res) => {
    const { limit } = ownEventsQuery.parse(req.query);
    res.json({ success: true, data: await this.security.listOwnEvents(getAuthenticatedUser(req), limit) });
  });

  public adminListSessions = wrap(async (req, res) => {
    const { userId } = userParams.parse(req.params);
    res.json({ success: true, data: await this.security.adminListSessions(getAuthenticatedUser(req), userId) });
  });

  public adminRevokeSession = wrap(async (req, res) => {
    const { userId, sessionId } = userSessionParams.parse(req.params);
    res.json({ success: true, data: await this.security.adminRevokeSession(getAuthenticatedUser(req), userId, sessionId, clientOf(req)) });
  });

  public adminListSecurityEvents = wrap(async (req, res) => {
    const filter = adminEventsQuery.parse(req.query);
    const page = await this.security.adminListEvents(getAuthenticatedUser(req), filter);
    res.json({ success: true, data: page.items, pagination: { limit: filter.limit, nextCursor: page.nextCursor } });
  });

  public listIpRules = wrap(async (_req, res) => {
    res.json({ success: true, data: await this.security.ipRules.list() });
  });

  public createIpRule = wrap(async (req, res) => {
    const input = newRuleSchema.parse(req.body);
    res.status(201).json({ success: true, data: await this.security.ipRules.create(getAuthenticatedUser(req), input, req.ip) });
  });

  public removeIpRule = wrap(async (req, res) => {
    const { ruleId } = ruleParams.parse(req.params);
    await this.security.ipRules.remove(getAuthenticatedUser(req), ruleId);
    res.json({ success: true, data: { id: ruleId, removed: true } });
  });

  public listIpBans = wrap(async (_req, res) => {
    const { bans, complete } = await this.security.ipRules.listBans();
    res.json({ success: true, data: bans, pagination: { complete } });
  });

  public liftIpBan = wrap(async (req, res) => {
    const { ipKey } = banParams.parse(req.params);
    await this.security.ipRules.liftBan(getAuthenticatedUser(req), ipKey);
    res.json({ success: true, data: { ipKey, lifted: true } });
  });

  public verifyAudit = wrap(async (req, res) => {
    res.json({ success: true, data: await this.security.verifyAudit(getAuthenticatedUser(req)) });
  });
}
