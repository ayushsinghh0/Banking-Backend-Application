import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BadRequestError, getAuthenticatedUser, parsePagination } from '@banksphere/common';
import { LedgerService } from '../services/ledger.service';
import { IdempotencyService } from '../services/idempotency.service';

// Max 18 digits keeps amounts well inside Postgres BIGINT
const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, { message: 'amountInPaise must be a positive integer string' });

const transferSchema = z
  .object({
    sourceAccountId: z.string().uuid({ message: 'sourceAccountId must be a valid UUID' }),
    destinationAccountId: z.string().uuid({ message: 'destinationAccountId must be a valid UUID' }).optional(),
    destinationAccountNumber: z.string().regex(/^\d{12}$/).optional(),
    amountInPaise: amountSchema,
    description: z.string().trim().max(255).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.destinationAccountId) !== Boolean(b.destinationAccountNumber), {
    message: 'Provide exactly one of destinationAccountId or destinationAccountNumber',
    path: ['destinationAccountId'],
  });

const depositWithdrawSchema = z
  .object({
    accountId: z.string().uuid({ message: 'accountId must be a valid UUID' }),
    amountInPaise: amountSchema,
    description: z.string().trim().max(255).optional(),
  })
  .strict();

const accountIdParams = z.object({ accountId: z.string().uuid() });

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function readIdempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key');
  if (!key) {
    throw new BadRequestError("Header 'Idempotency-Key' is required for financial write operations");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new BadRequestError("'Idempotency-Key' must be 8-128 characters of [A-Za-z0-9_-] (a UUID is recommended)");
  }
  return key;
}

export class TransactionController {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly idempotencyService: IdempotencyService
  ) {}

  private async runIdempotent(
    req: Request,
    res: Response,
    endpoint: string,
    body: Record<string, unknown>,
    work: Parameters<IdempotencyService['execute']>[1]
  ): Promise<void> {
    const actor = getAuthenticatedUser(req);
    const key = readIdempotencyKey(req);
    const result = await this.idempotencyService.execute(
      {
        userId: actor.id,
        key,
        endpoint,
        requestHash: this.idempotencyService.generateRequestHash(body),
      },
      work
    );

    if (result.replayed) {
      res.setHeader('X-Idempotent-Replay', 'true');
    }
    res.status(result.statusCode).json(result.responseBody);
  }

  public transfer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const body = transferSchema.parse(req.body);

      await this.runIdempotent(req, res, 'transfer', body, (tx) =>
        this.ledgerService.executeTransfer(
          {
            sourceAccountId: body.sourceAccountId,
            destinationAccountId: body.destinationAccountId,
            destinationAccountNumber: body.destinationAccountNumber,
            amountInPaise: BigInt(body.amountInPaise),
            description: body.description,
          },
          actor,
          tx
        )
      );
    } catch (error) {
      next(error);
    }
  };

  public deposit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const body = depositWithdrawSchema.parse(req.body);

      await this.runIdempotent(req, res, 'deposit', body, (tx) =>
        this.ledgerService.executeDeposit(
          {
            accountId: body.accountId,
            amountInPaise: BigInt(body.amountInPaise),
            description: body.description,
          },
          actor,
          tx
        )
      );
    } catch (error) {
      next(error);
    }
  };

  public withdraw = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getAuthenticatedUser(req);
      const body = depositWithdrawSchema.parse(req.body);

      await this.runIdempotent(req, res, 'withdraw', body, (tx) =>
        this.ledgerService.executeWithdrawal(
          {
            accountId: body.accountId,
            amountInPaise: BigInt(body.amountInPaise),
            description: body.description,
          },
          actor,
          tx
        )
      );
    } catch (error) {
      next(error);
    }
  };

  public getBalance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { accountId } = accountIdParams.parse(req.params);
      const balance = await this.ledgerService.getAccountBalance(accountId, getAuthenticatedUser(req));
      res.json({ success: true, data: balance });
    } catch (error) {
      next(error);
    }
  };

  public getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { accountId } = accountIdParams.parse(req.params);
      const { limit, offset } = parsePagination(req.query);

      const history = await this.ledgerService.getTransactionHistory(
        accountId,
        getAuthenticatedUser(req),
        limit,
        offset
      );
      res.json({ success: true, data: history, pagination: { limit, offset } });
    } catch (error) {
      next(error);
    }
  };
}
