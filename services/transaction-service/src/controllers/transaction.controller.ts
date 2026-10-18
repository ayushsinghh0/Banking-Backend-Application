import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BadRequestError, getAuthenticatedUser, parsePagination } from '@banksphere/common';
import { LedgerService } from '../services/ledger.service';
import { TellerService } from '../services/teller.service';
import { BeneficiaryService } from '../services/beneficiary.service';
import { IdempotencyService } from '../services/idempotency.service';
import { CashOperationResult } from '../types';

// Max 18 digits keeps amounts well inside Postgres BIGINT
const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, { message: 'amountInPaise must be a positive integer string' });
const nonNegativeAmount = z.string().regex(/^\d{1,18}$/, { message: 'Must be a non-negative integer string in paise' });

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

const depositSchema = z
  .object({
    accountId: z.string().uuid({ message: 'accountId must be a valid UUID' }),
    amountInPaise: amountSchema,
    description: z.string().trim().max(255).optional(),
  })
  .strict();

const withdrawSchema = depositSchema.extend({
  authorizationCode: z.string().regex(/^\d{8}$/, { message: 'authorizationCode must be the 8-digit code from the customer' }),
});

const withdrawalCodeSchema = z.object({ accountId: z.string().uuid(), amountInPaise: amountSchema }).strict();
const beneficiarySchema = z.object({ accountNumber: z.string().regex(/^\d{12}$/), nickname: z.string().trim().min(1).max(60) }).strict();
const issueFloatSchema = z.object({ tellerId: z.string().uuid(), openingFloatPaise: nonNegativeAmount }).strict();
const acceptFloatSchema = z.object({ countedFloatPaise: nonNegativeAmount }).strict();
const countSchema = z.object({ countedCashPaise: nonNegativeAmount }).strict();

const accountIdParams = z.object({ accountId: z.string().uuid() });
const idParams = z.object({ id: z.string().uuid() });
const cashOperationParams = z.object({ cashOperationId: z.string().uuid() });
const cashListQuery = z.object({ status: z.enum(['PENDING_APPROVAL', 'EXECUTED', 'REJECTED']).optional() });
const sessionListQuery = z.object({ status: z.enum(['ISSUED', 'OPEN', 'CLOSED', 'RECONCILED', 'CANCELLED']).optional() });

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

function cashResponse(result: CashOperationResult): { statusCode: number; data: unknown } {
  // 202 Accepted: recorded, waiting for a second administrator
  return { statusCode: result.status === 'EXECUTED' ? 201 : 202, data: result };
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export class TransactionController {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly tellerService: TellerService,
    private readonly beneficiaryService: BeneficiaryService,
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
    const result = await this.idempotencyService.execute(
      {
        userId: actor.id,
        key: readIdempotencyKey(req),
        endpoint,
        requestHash: this.idempotencyService.generateRequestHash(body),
      },
      work
    );
    if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
    res.status(result.statusCode).json(result.responseBody);
  }

  // --- customer -------------------------------------------------------------

  public transfer = wrap(async (req, res) => {
    const actor = getAuthenticatedUser(req);
    const body = transferSchema.parse(req.body);
    await this.runIdempotent(req, res, 'transfer', body, async (tx) => ({
      statusCode: 201,
      data: await this.ledgerService.executeTransfer(
        {
          sourceAccountId: body.sourceAccountId,
          destinationAccountId: body.destinationAccountId,
          destinationAccountNumber: body.destinationAccountNumber,
          amountInPaise: BigInt(body.amountInPaise),
          description: body.description,
        },
        actor,
        tx
      ),
    }));
  });

  public createWithdrawalCode = wrap(async (req, res) => {
    const { accountId, amountInPaise } = withdrawalCodeSchema.parse(req.body);
    const data = await this.tellerService.createWithdrawalCode(getAuthenticatedUser(req), accountId, BigInt(amountInPaise));
    res.status(201).json({ success: true, data });
  });

  public addBeneficiary = wrap(async (req, res) => {
    const { accountNumber, nickname } = beneficiarySchema.parse(req.body);
    res.status(201).json({ success: true, data: await this.beneficiaryService.add(getAuthenticatedUser(req), accountNumber, nickname) });
  });

  public listBeneficiaries = wrap(async (req, res) => {
    res.json({ success: true, data: await this.beneficiaryService.list(getAuthenticatedUser(req)) });
  });

  public removeBeneficiary = wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    await this.beneficiaryService.remove(getAuthenticatedUser(req), id);
    res.json({ success: true });
  });

  // --- teller ---------------------------------------------------------------

  public deposit = wrap(async (req, res) => {
    const actor = getAuthenticatedUser(req);
    const body = depositSchema.parse(req.body);
    await this.runIdempotent(req, res, 'deposit', body, async (tx) =>
      cashResponse(
        await this.tellerService.requestCashOperation(
          { type: 'DEPOSIT', accountId: body.accountId, amountInPaise: BigInt(body.amountInPaise), description: body.description },
          actor,
          tx
        )
      )
    );
  });

  public withdraw = wrap(async (req, res) => {
    const actor = getAuthenticatedUser(req);
    const body = withdrawSchema.parse(req.body);
    await this.runIdempotent(req, res, 'withdrawal', body, async (tx) =>
      cashResponse(
        await this.tellerService.requestCashOperation(
          {
            type: 'WITHDRAWAL',
            accountId: body.accountId,
            amountInPaise: BigInt(body.amountInPaise),
            description: body.description,
            authorizationCode: body.authorizationCode,
          },
          actor,
          tx
        )
      )
    );
  });

  public acceptFloat = wrap(async (req, res) => {
    const { countedFloatPaise } = acceptFloatSchema.parse(req.body);
    res.json({ success: true, data: await this.tellerService.acceptFloat(getAuthenticatedUser(req), BigInt(countedFloatPaise)) });
  });

  public closeSession = wrap(async (req, res) => {
    const { countedCashPaise } = countSchema.parse(req.body);
    res.json({ success: true, data: await this.tellerService.closeSession(getAuthenticatedUser(req), BigInt(countedCashPaise)) });
  });

  // --- supervisor -----------------------------------------------------------

  public issueFloat = wrap(async (req, res) => {
    const { tellerId, openingFloatPaise } = issueFloatSchema.parse(req.body);
    res.status(201).json({ success: true, data: await this.tellerService.issueFloat(getAuthenticatedUser(req), tellerId, BigInt(openingFloatPaise)) });
  });

  public cancelFloat = wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    await this.tellerService.cancelFloat(getAuthenticatedUser(req), id);
    res.json({ success: true, data: { id, status: 'CANCELLED' } });
  });

  public signOffSession = wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { countedCashPaise } = countSchema.parse(req.body);
    res.json({ success: true, data: await this.tellerService.signOffSession(getAuthenticatedUser(req), id, BigInt(countedCashPaise)) });
  });

  public listSessions = wrap(async (req, res) => {
    const { status } = sessionListQuery.parse(req.query);
    const { limit, offset } = parsePagination(req.query);
    res.json({ success: true, data: await this.tellerService.listSessions(status, limit, offset), pagination: { limit, offset } });
  });

  public approveCashOperation = wrap(async (req, res) => {
    const actor = getAuthenticatedUser(req);
    const { cashOperationId } = cashOperationParams.parse(req.params);
    await this.runIdempotent(req, res, 'cash-approve', { cashOperationId }, async (tx) =>
      cashResponse(await this.tellerService.approveCashOperation(cashOperationId, actor, tx))
    );
  });

  public rejectCashOperation = wrap(async (req, res) => {
    const { cashOperationId } = cashOperationParams.parse(req.params);
    await this.tellerService.rejectCashOperation(cashOperationId, getAuthenticatedUser(req));
    res.status(200).json({ success: true, data: { cashOperationId, status: 'REJECTED' } });
  });

  public listCashOperations = wrap(async (req, res) => {
    const { status } = cashListQuery.parse(req.query);
    const { limit, offset } = parsePagination(req.query);
    res.json({ success: true, data: await this.tellerService.listCashOperations(status, limit, offset), pagination: { limit, offset } });
  });

  // --- reads ----------------------------------------------------------------

  public getBalance = wrap(async (req, res) => {
    const { accountId } = accountIdParams.parse(req.params);
    res.json({ success: true, data: await this.ledgerService.getAccountBalance(accountId, getAuthenticatedUser(req)) });
  });

  public getHistory = wrap(async (req, res) => {
    const { accountId } = accountIdParams.parse(req.params);
    const { limit, offset } = parsePagination(req.query);
    const history = await this.ledgerService.getTransactionHistory(accountId, getAuthenticatedUser(req), limit, offset);
    res.json({ success: true, data: history, pagination: { limit, offset } });
  });
}
