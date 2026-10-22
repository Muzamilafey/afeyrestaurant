import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLog } from '../models';
import type { RequestContext } from '../http/context';
import { logger } from '../lib/logger';

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: string | Types.ObjectId;
  reason?: string;
  approvedBy?: Types.ObjectId | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  branchId?: Types.ObjectId | null;
}

/** Record an audit entry. Secrets must never be passed in before/after/meta. */
export async function audit(ctx: RequestContext | null, input: AuditInput, req?: Request) {
  try {
    await AuditLog.create({
      tenantId: ctx?.tenantId ?? null,
      branchId: input.branchId ?? ctx?.branchId ?? undefined,
      actorId: ctx?.userId,
      actorName: ctx?.userName,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ? String(input.entityId) : undefined,
      reason: input.reason,
      approvedBy: input.approvedBy ?? undefined,
      before: input.before,
      after: input.after,
      meta: input.meta,
      ip: req?.ip,
      requestId: req?.id,
    });
  } catch (e) {
    logger.error({ err: e, action: input.action }, 'Failed to write audit log');
  }
}
