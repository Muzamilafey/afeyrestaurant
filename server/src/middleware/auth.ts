import type { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { verifyAccessToken } from '../auth/tokens';
import { User, Role, Tenant, Branch, Subscription, Plan } from '../models';
import { AppError, forbidden, unauthorized, badRequest } from '../lib/errors';
import type { Permission } from '../auth/permissions';
import { ALL_PERMISSIONS } from '../auth/permissions';
import type { RequestContext } from '../http/context';
import { isOid } from '../models/common';

/** Short-lived caches for tenant status and plan features (invalidated on change). */
const tenantCache = new Map<string, { at: number; status: string; features: Set<string> }>();
export const invalidateTenantCache = (tenantId?: string) => (tenantId ? tenantCache.delete(tenantId) : tenantCache.clear());

async function tenantState(tenantId: Types.ObjectId) {
  const key = String(tenantId);
  const hit = tenantCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw unauthorized('Tenant not found');
  const sub = await Subscription.findOne({ tenantId }).lean();
  const plan = sub ? await Plan.findById(sub.planId).lean() : null;
  let status = tenant.status as string;
  if (sub && ['suspended', 'cancelled'].includes(sub.status)) status = 'suspended';
  if (sub && sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt < new Date()) status = 'expired';
  const state = { at: Date.now(), status, features: new Set<string>(plan?.features ?? []) };
  tenantCache.set(key, state);
  return state;
}

export async function buildContext(userId: string, tokenVersion: number | null, req: Request): Promise<RequestContext> {
  if (!isOid(userId)) throw unauthorized();
  // Lookup by primary key from a verified token; the tenant is then taken from the user record itself.
  const user = await User.findOne({ _id: userId }).setOptions({ skipTenantGuard: true }).lean();
  if (!user || !user.active) throw unauthorized('Account disabled');
  if (tokenVersion !== null && (user.tokenVersion ?? 0) !== tokenVersion) throw unauthorized('Session revoked');

  if (user.isPlatformAdmin) {
    return {
      userId: user._id, userName: user.name, email: user.email, tenantId: null, branchId: null, allowedBranchIds: [],
      allBranches: true, permissions: new Set(ALL_PERMISSIONS), roleKey: 'platform_admin', isPlatformAdmin: true, features: new Set(),
    };
  }
  const tenantId = user.tenantId as Types.ObjectId;
  // A tenant hostname (subdomain/custom domain) must match the user's tenant.
  if (req.hostTenantId && !req.hostTenantId.equals(tenantId)) throw forbidden('This account does not belong to this restaurant');

  const state = await tenantState(tenantId);
  if (state.status === 'suspended' || state.status === 'cancelled') throw new AppError(403, 'TENANT_SUSPENDED', 'This account is suspended. Contact your administrator.');
  if (state.status === 'expired') throw new AppError(402, 'SUBSCRIPTION_EXPIRED', 'Your trial has ended. Please renew your subscription.');

  const role = user.roleId ? await Role.findOne({ _id: user.roleId, tenantId }).lean() : null;
  const permissions = new Set<Permission>((role?.permissions ?? []) as Permission[]);
  const allBranches = role ? !role.branchScoped : false;
  let allowed = (user.branchIds ?? []) as Types.ObjectId[];
  if (allBranches) {
    allowed = (await Branch.find({ tenantId, active: true }, { _id: 1 }).lean()).map((b) => b._id);
  }
  const requested = req.header('x-branch-id');
  let branchId: Types.ObjectId | null = null;
  if (requested) {
    if (!isOid(requested)) throw badRequest('Invalid X-Branch-Id');
    branchId = new Types.ObjectId(requested);
    if (!allowed.some((b) => b.equals(branchId!))) throw forbidden('You are not assigned to this branch');
  } else if (user.defaultBranchId && allowed.some((b) => b.equals(user.defaultBranchId!))) {
    branchId = user.defaultBranchId as Types.ObjectId;
  } else if (allowed.length) {
    branchId = allowed[0];
  }
  return {
    userId: user._id, userName: user.name, email: user.email, tenantId, branchId, allowedBranchIds: allowed, allBranches,
    permissions, roleKey: role?.key ?? null, isPlatformAdmin: false, features: state.features,
  };
}

export function authenticate(opts: { requireTenant?: boolean; requireBranch?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const h = req.header('authorization');
      if (!h?.startsWith('Bearer ')) throw unauthorized();
      const claims = verifyAccessToken(h.slice(7));
      const ctx = await buildContext(claims.sub, claims.ver, req);
      if (opts.requireTenant && !ctx.tenantId) throw forbidden('This endpoint requires a restaurant account');
      if (opts.requireBranch && !ctx.branchId) throw forbidden('No branch selected or assigned');
      req.ctx = ctx;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Passes when the user holds ANY of the listed permissions. */
export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.ctx;
    if (!ctx) return next(unauthorized());
    if (perms.some((p) => ctx.permissions.has(p))) return next();
    next(forbidden(`Missing permission: ${perms.join(' or ')}`));
  };
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.ctx?.isPlatformAdmin) return next(forbidden('Platform administrator access required'));
  next();
}

export function requireFeature(feature: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.ctx?.isPlatformAdmin || req.ctx?.features.has(feature)) return next();
    next(new AppError(402, 'FEATURE_NOT_IN_PLAN', `Your subscription plan does not include "${feature}". Upgrade to enable it.`));
  };
}

export const hasPerm = (ctx: RequestContext, p: Permission) => ctx.permissions.has(p);
export function assertPerm(ctx: RequestContext, p: Permission, message?: string) {
  if (!ctx.permissions.has(p)) throw forbidden(message ?? `Missing permission: ${p}`);
}
/** Check the user may act on a branch (for endpoints that accept an explicit branchId). */
export function assertBranch(ctx: RequestContext, branchId: Types.ObjectId | string) {
  const id = String(branchId);
  if (!ctx.allowedBranchIds.some((b) => String(b) === id)) throw forbidden('You are not assigned to this branch');
}
