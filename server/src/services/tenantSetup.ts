import type { ClientSession } from 'mongoose';
import { Tenant, Branch, Role, User, Plan, Subscription, TaxRate } from '../models';
import { SYSTEM_ROLES } from '../auth/permissions';
import { hashPassword, passwordPolicy } from '../auth/password';
import { badRequest, conflict } from '../lib/errors';
import { withTransaction } from '../db/connect';

export interface CreateTenantInput {
  name: string;
  slug: string;
  planCode: string;
  contactEmail?: string;
  contactPhone?: string;
  branch: { name: string; code: string; address?: string; phone?: string };
  owner: { name: string; email: string; password: string; phone?: string };
}

export async function ensureSystemRoles(tenantId: unknown, session?: ClientSession) {
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    await Role.updateOne(
      { tenantId, key },
      { $set: { name: def.name, description: def.description, permissions: def.permissions, branchScoped: def.branchScoped, system: true } },
      { upsert: true, session },
    );
  }
}

/** Provision a tenant: tenant, first branch, system roles, owner account, trial subscription and default taxes. */
export async function createTenant(input: CreateTenantInput) {
  const policy = passwordPolicy(input.owner.password);
  if (policy) throw badRequest(policy);
  const plan = await Plan.findOne({ code: input.planCode, active: true }).lean();
  if (!plan) throw badRequest('Unknown plan');
  if (await Tenant.exists({ slug: input.slug.toLowerCase() })) throw conflict('That subdomain is already taken', 'SLUG_TAKEN');
  const passwordHash = await hashPassword(input.owner.password);
  return withTransaction(async (session) => {
    const [tenant] = await Tenant.create([{ name: input.name, slug: input.slug.toLowerCase(), contactEmail: input.contactEmail ?? input.owner.email, contactPhone: input.contactPhone, status: 'trial' }], { session });
    const [branch] = await Branch.create([{ tenantId: tenant._id, ...input.branch }], { session });
    await ensureSystemRoles(tenant._id, session);
    const ownerRole = await Role.findOne({ tenantId: tenant._id, key: 'owner' }).session(session);
    const [owner] = await User.create(
      [{ tenantId: tenant._id, email: input.owner.email.toLowerCase(), name: input.owner.name, phone: input.owner.phone, passwordHash, roleId: ownerRole!._id, branchIds: [branch._id], defaultBranchId: branch._id }],
      { session },
    );
    const now = new Date();
    const trialEnds = new Date(now.getTime() + (plan.trialDays ?? 14) * 86400_000);
    await Subscription.create([{ tenantId: tenant._id, planId: plan._id, status: 'trialing', trialEndsAt: trialEnds, currentPeriodStart: now, currentPeriodEnd: trialEnds, history: [{ at: now, action: 'created', note: `Trial on ${plan.code}` }] }], { session });
    // Kenyan defaults — editable per tenant. VAT 16% (standard rate) and the 2% Catering Levy where applicable.
    await TaxRate.create(
      [
        { tenantId: tenant._id, name: 'VAT 16%', code: 'VAT', rateBps: 1600, inclusive: true, active: true },
        { tenantId: tenant._id, name: 'Catering Levy 2%', code: 'CTL', rateBps: 200, inclusive: true, active: false },
      ],
      { session, ordered: true },
    );
    return { tenant, branch, owner };
  });
}

export const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', description: 'Single outlet POS', priceMonthly: 250000, priceAnnual: 2500000, limits: { branches: 1, users: 8, terminals: 2, products: 300 }, features: ['pos', 'tables', 'kds', 'bar', 'mpesa', 'sms', 'email', 'offline', 'reservations', 'inventory'] },
  { code: 'growth', name: 'Growth', description: 'Full restaurant & bar operations', priceMonthly: 550000, priceAnnual: 5500000, limits: { branches: 3, users: 30, terminals: 8, products: 1500 }, features: ['pos', 'tables', 'kds', 'bar', 'inventory', 'recipes', 'procurement', 'mpesa', 'sms', 'email', 'reservations', 'delivery', 'loyalty', 'attendance', 'reports_advanced', 'multi_branch', 'offline'] },
  { code: 'enterprise', name: 'Enterprise', description: 'Multi-branch groups with biometrics and API access', priceMonthly: 1200000, priceAnnual: 12000000, limits: { branches: 50, users: 500, terminals: 100, products: 10000 }, features: ['pos', 'tables', 'kds', 'bar', 'inventory', 'recipes', 'procurement', 'mpesa', 'sms', 'email', 'reservations', 'delivery', 'loyalty', 'attendance', 'biometrics', 'reports_advanced', 'multi_branch', 'offline', 'api_access'] },
];

export async function ensurePlans() {
  for (const p of DEFAULT_PLANS) await Plan.updateOne({ code: p.code }, { $setOnInsert: p }, { upsert: true });
}
