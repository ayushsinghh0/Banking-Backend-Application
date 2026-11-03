import { AdminRequestStatus, AdminRequestType, Prisma, PrismaClient, Role } from '../../generated/client';
import { AuthenticatedUser, ConflictError, ForbiddenError, HttpError, NotFoundError } from '@banksphere/common';
import { AuthService, STAFF_ROLES, normaliseEmail } from './auth.service';

const REQUEST_TTL_HOURS = Number(process.env.ADMIN_REQUEST_TTL_HOURS || 24);

export type AdminRequestInput =
  | { type: 'CREATE_STAFF'; email: string; role: Role }
  | { type: 'SET_USER_ACTIVE'; userId: string; isActive: boolean }
  | { type: 'RESET_MFA'; userId: string };

/**
 * Four-eyes administration. Every privileged identity change (creating staff, enabling/disabling staff,
 * resetting staff MFA) is first recorded as a request by one BANK_ADMIN and executed only when a
 * DIFFERENT BANK_ADMIN approves it. Nobody can approve or reject a request that concerns themselves, and the
 * admin who requested a staff account can never approve it, so a single insider can't mint a puppet.
 */
export class AdminRequestService {
  constructor(private readonly prisma: PrismaClient, private readonly auth: AuthService) {}

  public async request(actor: AuthenticatedUser, input: AdminRequestInput) {
    let targetUserId: string | null = null;
    let payload: Record<string, unknown>;

    switch (input.type) {
      case 'CREATE_STAFF': {
        if (!STAFF_ROLES.includes(input.role)) throw new HttpError(400, 'INVALID_ROLE', 'Only staff roles can be requested');
        this.auth.assertStaffEmailAllowed(input.email);
        const email = normaliseEmail(input.email);
        if (await this.prisma.user.findUnique({ where: { email } })) {
          throw new ConflictError('An account with this email already exists');
        }
        payload = { email, role: input.role };
        break;
      }
      case 'SET_USER_ACTIVE':
      case 'RESET_MFA': {
        const target = await this.prisma.user.findUnique({ where: { id: input.userId } });
        if (!target) throw new NotFoundError('User not found');
        if (target.id === actor.id) throw new ForbiddenError('You cannot request changes to your own account');
        targetUserId = target.id;
        payload = input.type === 'SET_USER_ACTIVE' ? { userId: target.id, isActive: input.isActive } : { userId: target.id };
        break;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.adminRequest.create({
        data: {
          type: input.type as AdminRequestType,
          payload: payload as Prisma.InputJsonValue,
          targetUserId,
          requestedBy: actor.id,
          expiresAt: new Date(Date.now() + REQUEST_TTL_HOURS * 3600_000),
        },
      });
      await this.auth.audit(tx, actor.id, `ADMIN_REQUEST_${input.type}`, created.id, payload);
      return created;
    });
  }

  public async list(status: AdminRequestStatus | undefined, limit: number, offset: number) {
    return this.prisma.adminRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  public async approve(approver: AuthenticatedUser, requestId: string) {
    let afterCommit: () => Promise<void> = async () => {};

    const result = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM admin_requests WHERE id = ${requestId} FOR UPDATE`;
      if (!locked) throw new NotFoundError('Admin request not found');
      const request = await tx.adminRequest.findUniqueOrThrow({ where: { id: requestId } });

      if (request.status !== AdminRequestStatus.PENDING) throw new ConflictError(`Request is already ${request.status}`);
      if (request.requestedBy === approver.id) {
        throw new ForbiddenError('A request must be approved by a different administrator');
      }
      if (request.targetUserId === approver.id) {
        throw new ForbiddenError('You cannot approve a request that concerns your own account');
      }
      if (request.expiresAt < new Date()) {
        // Returned rather than thrown: a throw here would roll the expiry back and leave the request PENDING forever
        await tx.adminRequest.update({ where: { id: request.id }, data: { status: AdminRequestStatus.REJECTED, decidedAt: new Date() } });
        await this.auth.audit(tx, null, 'ADMIN_REQUEST_EXPIRED', request.id, { attemptedBy: approver.id });
        return null;
      }

      const payload = request.payload as Record<string, any>;
      let outcome: Record<string, unknown> = {};
      switch (request.type) {
        case AdminRequestType.CREATE_STAFF: {
          const { user, activationToken } = await this.auth.createStaffUserFromApproval(tx, payload.email, payload.role, request.id);
          outcome = { userId: user.id, email: user.email, role: user.role };
          afterCommit = async () => this.auth.sendStaffActivation(user, activationToken);
          break;
        }
        case AdminRequestType.SET_USER_ACTIVE: {
          const user = await this.auth.setUserActiveInTx(tx, approver.id, payload.userId, Boolean(payload.isActive));
          outcome = { userId: user.id, isActive: user.isActive };
          afterCommit = async () => this.auth.afterUserActiveChange(user);
          break;
        }
        case AdminRequestType.RESET_MFA: {
          const { user, enrolmentToken } = await this.auth.resetMfaInTx(tx, approver.id, payload.userId);
          outcome = { userId: user.id, mfaReset: true };
          afterCommit = async () => this.auth.afterMfaReset(user, enrolmentToken);
          break;
        }
      }

      const updated = await tx.adminRequest.update({
        where: { id: request.id },
        data: { status: AdminRequestStatus.APPROVED, decidedBy: approver.id, decidedAt: new Date() },
      });
      await this.auth.audit(tx, approver.id, `ADMIN_REQUEST_APPROVED_${request.type}`, request.id, { requestedBy: request.requestedBy, ...outcome });
      return { request: updated, outcome };
    });

    if (!result) throw new ConflictError('This request has expired');
    await afterCommit();
    return result;
  }

  /**
   * Any other administrator may reject a request, and the requester may withdraw their own; the target may
   * not, or a staff member could block their own suspension or MFA reset.
   */
  public async reject(actor: AuthenticatedUser, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.adminRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new NotFoundError('Admin request not found');
      if (request.targetUserId === actor.id) {
        throw new ForbiddenError('You cannot decide a request that concerns your own account');
      }
      const result = await tx.adminRequest.updateMany({
        where: { id: requestId, status: AdminRequestStatus.PENDING },
        data: { status: AdminRequestStatus.REJECTED, decidedBy: actor.id, decidedAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictError('Request is not pending');
      await this.auth.audit(tx, actor.id, 'ADMIN_REQUEST_REJECTED', requestId, request.requestedBy === actor.id ? { withdrawn: true } : undefined);
      return { id: requestId, status: AdminRequestStatus.REJECTED };
    });
  }
}

