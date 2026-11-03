import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser, parsePagination } from '@banksphere/common';
import { FraudService } from '../services/fraud.service';
import { AlertStatus } from '../../generated/client';

const evaluateSchema = z
  .object({
    transactionId: z.string().uuid(),
    accountId: z.string().uuid(),
    amountInPaise: z.string().regex(/^\d{1,18}$/),
    direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
  })
  .strict();

const alertStatusEnum = z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED']);
const alertsQuerySchema = z.object({ status: alertStatusEnum.optional() });
const alertIdParams = z.object({ alertId: z.string().uuid() });
const alertUpdateSchema = z.object({ status: alertStatusEnum, note: z.string().trim().max(1000).optional() }).strict();

export class FraudController {
  constructor(private readonly fraudService: FraudService) {}

  public evaluate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = evaluateSchema.parse(req.body);
      // Dry run: scores without recording anything
      const result = await this.fraudService.previewTransaction({
        transactionId: validated.transactionId,
        accountId: validated.accountId,
        amountInPaise: BigInt(validated.amountInPaise),
        timestamp: new Date(),
        direction: validated.direction,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public getAlerts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status } = alertsQuerySchema.parse(req.query);
      const { limit, offset } = parsePagination(req.query);

      const alerts = await this.fraudService.getAlerts(status as AlertStatus | undefined, limit, offset);
      res.status(200).json({
        success: true,
        data: alerts,
        pagination: { limit, offset },
      });
    } catch (error) {
      next(error);
    }
  };

  public updateAlert = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { alertId } = alertIdParams.parse(req.params);
      const { status, note } = alertUpdateSchema.parse(req.body);
      const alert = await this.fraudService.updateAlertStatus(getAuthenticatedUser(req), alertId, status as AlertStatus, note);
      res.status(200).json({ success: true, data: alert });
    } catch (error) {
      next(error);
    }
  };

  public getAlertHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { alertId } = alertIdParams.parse(req.params);
      res.status(200).json({ success: true, data: await this.fraudService.getAlertHistory(alertId) });
    } catch (error) {
      next(error);
    }
  };
}
