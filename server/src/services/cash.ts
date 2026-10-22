import type { ClientSession, Types } from 'mongoose';
import { Branch, CashSession } from '../models';

/**
 * How a branch handles cash: 'per_user' — every cashier/waiter opens, counts and closes their own drawer (default);
 * 'shared' — one drawer for the whole branch: one person opens it, everyone's cash payments go into it, and it is
 * counted and closed once. Set per branch in Settings → Branches.
 */
export type DrawerMode = 'per_user' | 'shared';

interface DrawerCtx {
  tenantId: Types.ObjectId;
  branchId: Types.ObjectId;
  userId: Types.ObjectId;
}

export async function drawerMode(ctx: Pick<DrawerCtx, 'tenantId' | 'branchId'>, session?: ClientSession): Promise<DrawerMode> {
  const b = await Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }, { 'settings.cashDrawerMode': 1 }).session(session ?? null).lean();
  return b?.settings?.cashDrawerMode === 'shared' ? 'shared' : 'per_user';
}

export function openDrawerFilter(ctx: DrawerCtx, mode: DrawerMode) {
  return mode === 'shared'
    ? { tenantId: ctx.tenantId, branchId: ctx.branchId, shared: true, status: 'open' }
    : { tenantId: ctx.tenantId, branchId: ctx.branchId, userId: ctx.userId, shared: { $ne: true }, status: 'open' };
}

/** The drawer this user's cash goes into right now: their own, or the branch's shared drawer. */
export async function findOpenDrawer(ctx: DrawerCtx, session?: ClientSession) {
  const mode = await drawerMode(ctx, session);
  const drawer = await CashSession.findOne(openDrawerFilter(ctx, mode)).session(session ?? null);
  return { mode, drawer };
}

export const noDrawerMessage = (mode: DrawerMode, action: string) =>
  mode === 'shared' ? `The shared cash drawer is not open. Ask a manager or cashier to open it ${action}` : `Open your cash drawer ${action}`;
