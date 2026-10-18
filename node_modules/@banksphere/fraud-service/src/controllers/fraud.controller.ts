import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { FraudService } from '../services/fraud.service';
import { AlertStatus } from '../generated/client';

const evaluateSchema = z.object({
  transactionId: z.string().uuid(),
  accountId: z.string().uuid(),
  amountInPaise: z.string().regex(/^\d+$/),
});

export class FraudController {
  constructor(private readonly fraudService: FraudService) {}

  public evaluate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = evaluateSchema.parse(req.body);
      const result = await this.fraudService.evaluateTransaction({
        transactionId: validated.transactionId,
        accountId: validated.accountId,
        amountInPaise: BigInt(validated.amountInPaise),
        timestamp: new Date(),
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
      const status = req.query.status as AlertStatus | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

      const alerts = await this.fraudService.getAlerts(status, limit);
      res.status(200).json({
        success: true,
        data: alerts,
      });
    } catch (error) {
      next(error);
    }
  };
}
