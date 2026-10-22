import { z } from 'zod';
import { Types } from 'mongoose';
import { createModule, zId } from '../../http/route';
import { Branch, User, Role, Tenant, TaxRate, Subscription, Plan, AuditLog, Terminal } from '../../models';
import { PERMISSIONS as P, ALL_PERMISSIONS } from '../../auth/permissions';
import { hashPassword, passwordPolicy } from '../../auth/password';
import { audit } from '../../services/audit';
import { badRequest, conflict, forbidden, notFound, AppError } from '../../lib/errors';
import { invalidateTenantCache } from '../../middleware/auth';
import { revokeAllForUser } from '../../auth/tokens';
import { randomToken } from '../../lib/crypto';

const m = createModule('/admin', 'Administration');

async function planLimits(tenantId: Types.ObjectId) {
  const sub = await Subscription.findOne({ tenantId }).lean();
  const plan = sub ? await Plan.findById(sub.planId).lean() : null;
  return plan?.limits ?? { branches: 1, users: 5, terminals: 1, products: 100 };
}

// ── Tenant settings ──
m.route({ method: 'get', path: '/tenant', summary: 'Tenant profile & settings', auth: 'tenant', permission: [P.SETTINGS_MANAGE, P.BRANCHES_MANAGE] }, async ({ ctx }) => Tenant.findById(ctx.tenantId).lean());
m.route(
  {
    method: 'patch', path: '/tenant', summary: 'Update tenant profile, branding and settings', auth: 'tenant', permission: P.SETTINGS_MANAGE,
    body: z.object({
      name: z.string().min(2).max(120).optional(), contactEmail: z.email().optional(), contactPhone: z.string().optional(), kraPin: z.string().max(20).optional(),
      customDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(5).optional(),
      branding: z.object({ logoUrl: z.string().max(500).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), receiptHeader: z.string().max(300).optional(), receiptFooter: z.string().max(300).optional() }).optional(),
      settings: z.object({
        timezone: z.string().optional(), discountApprovalThresholdBps: z.number().int().min(0).max(10000).optional(), loyaltyPointsPer100: z.number().min(0).max(100).optional(),
        loyaltyRedeemValue: z.number().int().min(0).optional(), costingPolicy: z.enum(['fifo', 'weighted_average']).optional(), allowNegativeStock: z.boolean().optional(),
        mpesaTimeoutSeconds: z.number().int().min(30).max(600).optional(), offlineAllowedActions: z.array(z.enum(['browse', 'create_order', 'cash_payment', 'print'])).optional(),
        alertEmails: z.array(z.email()).max(5).optional(), alertPhones: z.array(z.string().max(20)).max(5).optional(), dailySummary: z.boolean().optional(), lowStockAlerts: z.boolean().optional(),
      }).optional(),
    }),
  },
  async ({ ctx, body, req }) => {
    const t = await Tenant.findById(ctx.tenantId);
    if (!t) throw notFound('Tenant');
    const before = t.toObject();
    if (body.name) t.name = body.name;
    if (body.contactEmail) t.contactEmail = body.contactEmail;
    if (body.contactPhone) t.contactPhone = body.contactPhone;
    if (body.kraPin !== undefined) t.kraPin = body.kraPin;
    if (body.customDomains) t.customDomains = body.customDomains;
    if (body.branding) t.set('branding', { ...(before.branding ?? {}), ...body.branding });
    if (body.settings) t.set('settings', { ...(before.settings ?? {}), ...body.settings });
    await t.save();
    invalidateTenantCache(String(ctx.tenantId));
    await audit(ctx, { action: 'settings.tenant_updated', entity: 'Tenant', entityId: t._id, before: { settings: before.settings, branding: before.branding }, after: { settings: t.settings, branding: t.branding } }, req);
    return t;
  },
);

// ── Branches ──
const zBranch = z.object({
  name: z.string().min(2).max(80), code: z.string().regex(/^[A-Za-z0-9]{2,10}$/), address: z.string().max(200).optional(), phone: z.string().max(30).optional(), email: z.email().optional(), active: z.boolean().optional(),
  settings: z.object({
    serviceChargeBps: z.number().int().min(0).max(3000).optional(), serviceChargeModes: z.array(z.string()).optional(), receiptPrefix: z.string().max(6).optional(), orderPrefix: z.string().max(6).optional(),
    enabledModes: z.array(z.enum(['dine_in', 'takeaway', 'delivery', 'room_service', 'bar_counter', 'online'])).optional(), roomServiceEnabled: z.boolean().optional(), deliveryFee: z.number().int().min(0).optional(),
    openingTime: z.string().optional(), closingTime: z.string().optional(), kitchenDelayMinutes: z.number().int().min(1).max(240).optional(),
    happyHours: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), discountBps: z.number().int().min(0).max(10000).optional(), categoryIds: z.array(zId).optional() })).max(10).optional(),
  }).optional(),
});
m.route({ method: 'get', path: '/branches', summary: 'List branches you can access', auth: 'tenant' }, async ({ ctx }) => Branch.find({ tenantId: ctx.tenantId, _id: { $in: ctx.allowedBranchIds } }).sort({ name: 1 }).lean());
m.route({ method: 'post', path: '/branches', summary: 'Create a branch', auth: 'tenant', permission: P.BRANCHES_MANAGE, body: zBranch, status: 201 }, async ({ ctx, body, req }) => {
  const limits = await planLimits(ctx.tenantId);
  if ((await Branch.countDocuments({ tenantId: ctx.tenantId })) >= limits.branches) throw new AppError(402, 'PLAN_LIMIT', `Your plan allows ${limits.branches} branch(es). Upgrade to add more.`);
  const b = await Branch.create({ ...body, code: body.code.toUpperCase(), tenantId: ctx.tenantId });
  await audit(ctx, { action: 'branch.created', entity: 'Branch', entityId: b._id, after: body }, req);
  return b;
});
m.route({ method: 'patch', path: '/branches/:id', summary: 'Update a branch', auth: 'tenant', permission: P.BRANCHES_MANAGE, body: zBranch.partial() }, async ({ ctx, body, params, req }) => {
  if (!ctx.allowedBranchIds.some((b) => String(b) === params.id)) throw forbidden('You are not assigned to this branch');
  const b = await Branch.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!b) throw notFound('Branch');
  const before = b.toObject();
  const { settings, ...rest } = body;
  b.set(rest);
  if (settings) b.set('settings', { ...(before.settings ?? {}), ...settings });
  await b.save();
  await audit(ctx, { action: 'branch.updated', entity: 'Branch', entityId: b._id, before: before.settings, after: b.settings }, req);
  return b;
});

// ── Roles ──
m.route({ method: 'get', path: '/roles', summary: 'List roles', auth: 'tenant', permission: [P.USERS_MANAGE, P.ROLES_MANAGE] }, async ({ ctx }) => ({ roles: await Role.find({ tenantId: ctx.tenantId }).sort({ system: -1, name: 1 }).lean(), permissions: ALL_PERMISSIONS.filter((p) => p !== P.PLATFORM_ADMIN) }));
const zRole = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().min(2).max(60), description: z.string().max(200).optional(), permissions: z.array(z.enum(ALL_PERMISSIONS.filter((p) => p !== P.PLATFORM_ADMIN) as [string, ...string[]])), branchScoped: z.boolean() });
m.route({ method: 'put', path: '/roles/:key', summary: 'Create or update a custom role', auth: 'tenant', permission: P.ROLES_MANAGE, body: zRole }, async ({ ctx, body, params, req }) => {
  const existing = await Role.findOne({ tenantId: ctx.tenantId, key: params.key });
  if (existing?.key === 'owner') throw forbidden('The owner role cannot be modified');
  // A user cannot grant permissions they do not hold themselves.
  const escalation = body.permissions.filter((p) => !ctx.permissions.has(p as never));
  if (escalation.length) throw forbidden(`You cannot grant permissions you do not hold: ${escalation.join(', ')}`);
  const role = await Role.findOneAndUpdate({ tenantId: ctx.tenantId, key: params.key }, { $set: { ...body, key: params.key }, $setOnInsert: { system: false } }, { upsert: true, new: true });
  await audit(ctx, { action: 'role.saved', entity: 'Role', entityId: role._id, before: existing?.permissions, after: body.permissions }, req);
  return role;
});

// ── Users ──
const userView = (u: Record<string, any>) => ({ id: String(u._id), name: u.name, email: u.email, phone: u.phone, roleId: u.roleId ? String(u.roleId) : null, branchIds: (u.branchIds ?? []).map(String), defaultBranchId: u.defaultBranchId ? String(u.defaultBranchId) : null, active: u.active, lastLoginAt: u.lastLoginAt, mfaEnabled: !!u.mfa?.enabled, lockedUntil: u.lockedUntil });
m.route({ method: 'get', path: '/users', summary: 'List users', auth: 'tenant', permission: [P.USERS_MANAGE, P.STAFF_VIEW] }, async ({ ctx }) => {
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (!ctx.allBranches) filter.branchIds = { $in: ctx.allowedBranchIds };
  return (await User.find(filter).sort({ name: 1 }).lean()).map(userView);
});
const zUser = z.object({ name: z.string().min(2).max(80), email: z.email(), phone: z.string().optional(), password: z.string().max(200).optional(), pin: z.string().regex(/^\d{4,8}$/).optional(), roleId: zId, branchIds: z.array(zId).min(1), defaultBranchId: zId.optional(), active: z.boolean().optional() });

async function checkAssignable(ctx: { tenantId: Types.ObjectId; permissions: Set<string>; allowedBranchIds: Types.ObjectId[] }, roleId: string, branchIds: string[]) {
  const role = await Role.findOne({ tenantId: ctx.tenantId, _id: roleId }).lean();
  if (!role) throw badRequest('Unknown role');
  const escalation = role.permissions.filter((p) => !ctx.permissions.has(p));
  if (escalation.length) throw forbidden('You cannot assign a role with more permissions than your own');
  for (const b of branchIds) if (!ctx.allowedBranchIds.some((x) => String(x) === b)) throw forbidden('You cannot assign users to branches you do not manage');
  return role;
}

m.route({ method: 'post', path: '/users', summary: 'Create a user', auth: 'tenant', permission: P.USERS_MANAGE, body: zUser, status: 201 }, async ({ ctx, body, req }) => {
  await checkAssignable(ctx, body.roleId, body.branchIds);
  const limits = await planLimits(ctx.tenantId);
  if ((await User.countDocuments({ tenantId: ctx.tenantId, active: true })) >= limits.users) throw new AppError(402, 'PLAN_LIMIT', `Your plan allows ${limits.users} active users.`);
  if (!body.password) throw badRequest('Password is required');
  const policy = passwordPolicy(body.password);
  if (policy) throw badRequest(policy);
  if (await User.exists({ tenantId: ctx.tenantId, email: body.email.toLowerCase() })) throw conflict('A user with this email already exists');
  const u = await User.create({ tenantId: ctx.tenantId, name: body.name, email: body.email.toLowerCase(), phone: body.phone, passwordHash: await hashPassword(body.password), pinHash: body.pin ? await hashPassword(body.pin) : undefined, roleId: body.roleId, branchIds: body.branchIds, defaultBranchId: body.defaultBranchId ?? body.branchIds[0], active: body.active ?? true });
  await audit(ctx, { action: 'user.created', entity: 'User', entityId: u._id, after: { email: u.email, roleId: body.roleId, branchIds: body.branchIds } }, req);
  return userView(u.toObject());
});
m.route({ method: 'patch', path: '/users/:id', summary: 'Update a user (role, branches, status, password reset)', auth: 'tenant', permission: P.USERS_MANAGE, body: zUser.partial() }, async ({ ctx, body, params, req }) => {
  const u = await User.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!u) throw notFound('User');
  if (String(u._id) === String(ctx.userId) && (body.roleId || body.active === false)) throw forbidden('You cannot change your own role or deactivate yourself');
  const currentRole = await Role.findOne({ tenantId: ctx.tenantId, _id: u.roleId }).lean();
  if (currentRole?.key === 'owner' && ctx.roleKey !== 'owner') throw forbidden('Only an owner can modify an owner account');
  if (body.roleId || body.branchIds) await checkAssignable(ctx, body.roleId ?? String(u.roleId), body.branchIds ?? (u.branchIds ?? []).map(String));
  const before = userView(u.toObject());
  if (body.name) u.name = body.name;
  if (body.phone !== undefined) u.phone = body.phone;
  if (body.roleId) u.roleId = new Types.ObjectId(body.roleId);
  if (body.branchIds) u.branchIds = body.branchIds.map((b) => new Types.ObjectId(b));
  if (body.defaultBranchId) u.defaultBranchId = new Types.ObjectId(body.defaultBranchId);
  if (body.active !== undefined) u.active = body.active;
  if (body.pin) u.pinHash = await hashPassword(body.pin);
  let revoke = body.active === false || !!body.roleId;
  if (body.password) {
    const policy = passwordPolicy(body.password);
    if (policy) throw badRequest(policy);
    u.passwordHash = await hashPassword(body.password);
    u.lockedUntil = undefined;
    u.failedLogins = 0;
    revoke = true;
  }
  if (revoke) u.tokenVersion = (u.tokenVersion ?? 0) + 1;
  await u.save();
  if (revoke) await revokeAllForUser(u._id);
  await audit(ctx, { action: 'user.updated', entity: 'User', entityId: u._id, before, after: { ...userView(u.toObject()), passwordReset: !!body.password } }, req);
  return userView(u.toObject());
});

// ── Taxes ──
m.route({ method: 'get', path: '/taxes', summary: 'List tax rates', auth: 'tenant' }, async ({ ctx }) => TaxRate.find({ tenantId: ctx.tenantId }).lean());
m.route({ method: 'put', path: '/taxes/:code', summary: 'Create/update a tax rate', auth: 'tenant', permission: P.SETTINGS_MANAGE, body: z.object({ name: z.string(), rateBps: z.number().int().min(0).max(10000), inclusive: z.boolean(), active: z.boolean() }) }, async ({ ctx, body, params, req }) => {
  const t = await TaxRate.findOneAndUpdate({ tenantId: ctx.tenantId, code: params.code.toUpperCase() }, { $set: body }, { upsert: true, new: true });
  await audit(ctx, { action: 'tax.saved', entity: 'TaxRate', entityId: t._id, after: body }, req);
  return t;
});

// ── Terminals ──
m.route({ method: 'get', path: '/terminals', summary: 'List POS terminals', permission: P.SETTINGS_MANAGE }, async ({ ctx }) => Terminal.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/terminals', summary: 'Register a POS terminal', permission: P.SETTINGS_MANAGE, body: z.object({ name: z.string().min(1).max(40) }), status: 201 }, async ({ ctx, body }) => {
  const limits = await planLimits(ctx.tenantId);
  if ((await Terminal.countDocuments({ tenantId: ctx.tenantId, active: true })) >= limits.terminals) throw new AppError(402, 'PLAN_LIMIT', `Your plan allows ${limits.terminals} terminals.`);
  return Terminal.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, name: body.name, deviceKey: randomToken(12) });
});

// ── Subscription (tenant view) ──
m.route({ method: 'get', path: '/subscription', summary: 'Current subscription and plan', auth: 'tenant', permission: [P.SUBSCRIPTION_VIEW, P.SETTINGS_MANAGE] }, async ({ ctx }) => {
  const sub = await Subscription.findOne({ tenantId: ctx.tenantId }).lean();
  const plan = sub ? await Plan.findById(sub.planId).lean() : null;
  const usage = { branches: await Branch.countDocuments({ tenantId: ctx.tenantId }), users: await User.countDocuments({ tenantId: ctx.tenantId, active: true }), terminals: await Terminal.countDocuments({ tenantId: ctx.tenantId, active: true }) };
  return { subscription: sub, plan, usage, plans: await Plan.find({ active: true }).sort({ priceMonthly: 1 }).lean() };
});

// ── Audit ──
m.route({ method: 'get', path: '/audit', summary: 'Audit trail', auth: 'tenant', permission: P.AUDIT_VIEW, query: z.object({ action: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200), before: z.coerce.date().optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (query.action) f.action = new RegExp(`^${query.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (query.entityId) f.entityId = query.entityId;
  if (query.before) f.createdAt = { $lt: query.before };
  if (!ctx.allBranches) f.branchId = { $in: ctx.allowedBranchIds };
  return AuditLog.find(f).sort({ createdAt: -1 }).limit(query.limit).lean();
});

export default m;
