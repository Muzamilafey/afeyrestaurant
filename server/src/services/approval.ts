import { z } from 'zod';
import type { Types } from 'mongoose';
import { User, Role } from '../models';
import { verifyPassword } from '../auth/password';
import type { Permission } from '../auth/permissions';
import type { TenantContext } from '../http/context';
import { AppError } from '../lib/errors';

/** A manager override: the approving manager enters their email and POS PIN on the cashier's terminal. */
export const zApproval = z.object({ approverEmail: z.email(), pin: z.string().regex(/^\d{4,8}$/) }).optional();
export type ApprovalInput = z.infer<typeof zApproval>;

/**
 * Returns the id of the user whose authority covers `permission`: the actor themselves if they hold it,
 * otherwise a valid manager override. Throws APPROVAL_REQUIRED otherwise.
 */
export async function resolveApproval(ctx: TenantContext, permission: Permission, approval: ApprovalInput, what: string): Promise<Types.ObjectId> {
  if (ctx.permissions.has(permission)) return ctx.userId;
  if (!approval) throw new AppError(403, 'APPROVAL_REQUIRED', `${what} requires manager approval`, { permission });
  const approver = await User.findOne({ tenantId: ctx.tenantId, email: approval.approverEmail.toLowerCase(), active: true }).select('+pinHash').lean();
  if (!approver || !(await verifyPassword(approver.pinHash, approval.pin))) throw new AppError(403, 'APPROVAL_INVALID', 'Approver credentials are invalid');
  const role = approver.roleId ? await Role.findOne({ tenantId: ctx.tenantId, _id: approver.roleId }).lean() : null;
  if (!role?.permissions.includes(permission)) throw new AppError(403, 'APPROVAL_INVALID', 'Approver is not authorised for this action');
  if (role.branchScoped && ctx.branchId && !(approver.branchIds ?? []).some((b) => String(b) === String(ctx.branchId))) {
    throw new AppError(403, 'APPROVAL_INVALID', 'Approver is not assigned to this branch');
  }
  return approver._id;
}
