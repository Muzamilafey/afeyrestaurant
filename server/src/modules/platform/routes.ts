import { z } from 'zod';
import { createModule, zId } from '../../http/route';
import { Tenant, Plan, Subscription, User, Branch, Order, NotificationJob, Job, AuditLog, IntegrationConfiguration, SupportTicket, FEATURES } from '../../models';
import { createTenant } from '../../services/tenantSetup';
import { audit } from '../../services/audit';
import { invalidateTenantCache } from '../../middleware/auth';
import { notFound } from '../../lib/errors';
import { getBackupStatus } from '../../services/backupStatus';

const m = createModule('/platform', 'Platform');
const G = { skipTenantGuard: true };

m.route({ method: 'get', path: '/overview', summary: 'Platform KPIs', auth: 'platform' }, async () => {
  const [byStatus, subs, plans, failedJobs, deadNotifications, integrationErrors] = await Promise.all([
    Tenant.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Subscription.aggregate([{ $match: {} }, { $group: { _id: { status: '$status', planId: '$planId', interval: '$interval' }, n: { $sum: 1 } } }]).option(G),
    Plan.find().lean(),
    Job.countDocuments({ status: { $in: ['failed', 'dead'] } }).setOptions(G),
    NotificationJob.countDocuments({ status: { $in: ['failed', 'dead'] } }).setOptions(G),
    IntegrationConfiguration.countDocuments({ 'status.state': 'error' }).setOptions(G),
  ]);
  let mrr = 0;
  for (const s of subs) {
    if (s._id.status !== 'active') continue;
    const p = plans.find((x) => String(x._id) === String(s._id.planId));
    if (p) mrr += s.n * (s._id.interval === 'annual' ? Math.round(p.priceAnnual / 12) : p.priceMonthly);
  }
  const ordersToday = await Order.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }).setOptions(G);
  return {
    tenants: Object.fromEntries(byStatus.map((x) => [x._id, x.n])),
    subscriptions: subs.reduce((acc: Record<string, number>, s) => ({ ...acc, [s._id.status]: (acc[s._id.status] ?? 0) + s.n }), {}),
    mrr,
    arr: mrr * 12,
    ordersToday,
    health: { failedJobs, deadNotifications, integrationErrors },
    backup: await getBackupStatus(),
  };
});

m.route({ method: 'get', path: '/tenants', summary: 'List tenants', auth: 'platform', query: z.object({ q: z.string().optional(), status: z.string().optional() }) }, async ({ query }) => {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.q) filter.$or = [{ name: new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { slug: query.q.toLowerCase() }];
  const tenants = await Tenant.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const subs = await Subscription.find({ tenantId: { $in: tenants.map((t) => t._id) } }).lean();
  const plans = await Plan.find().lean();
  const counts = await Branch.aggregate([{ $match: { tenantId: { $in: tenants.map((t) => t._id) } } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]);
  return tenants.map((t) => {
    const s = subs.find((x) => String(x.tenantId) === String(t._id));
    return { ...t, subscription: s ? { ...s, plan: plans.find((p) => String(p._id) === String(s.planId))?.name } : null, branches: counts.find((c) => String(c._id) === String(t._id))?.n ?? 0 };
  });
});

m.route(
  {
    method: 'post', path: '/tenants', summary: 'Create a tenant with its first branch and owner', auth: 'platform', status: 201,
    body: z.object({
      name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/), planCode: z.string(), contactPhone: z.string().optional(),
      branch: z.object({ name: z.string().min(2), code: z.string().regex(/^[A-Za-z0-9]{2,10}$/), address: z.string().optional(), phone: z.string().optional() }),
      owner: z.object({ name: z.string().min(2), email: z.email(), password: z.string().min(10).max(200), phone: z.string().optional() }),
    }),
  },
  async ({ body, ctx, req }) => {
    const r = await createTenant(body);
    await audit(ctx, { action: 'platform.tenant_created', entity: 'Tenant', entityId: r.tenant._id, meta: { slug: body.slug, plan: body.planCode } }, req);
    return { tenantId: String(r.tenant._id), branchId: String(r.branch._id), ownerId: String(r.owner._id) };
  },
);

m.route(
  { method: 'post', path: '/tenants/:id/status', summary: 'Activate, suspend or cancel a tenant', auth: 'platform', body: z.object({ status: z.enum(['active', 'suspended', 'cancelled', 'trial']), reason: z.string().max(300).optional() }) },
  async ({ params, body, ctx, req }) => {
    const t = await Tenant.findByIdAndUpdate(params.id, { $set: { status: body.status, suspendedReason: body.status === 'suspended' ? body.reason : undefined } }, { new: true });
    if (!t) throw notFound('Tenant');
    const subStatus = body.status === 'active' ? 'active' : body.status === 'trial' ? 'trialing' : body.status;
    await Subscription.updateOne({ tenantId: t._id }, { $set: { status: subStatus }, $push: { history: { at: new Date(), action: `status:${body.status}`, by: ctx.userId, note: body.reason } } });
    invalidateTenantCache(String(t._id));
    await audit(ctx, { action: `platform.tenant_${body.status}`, entity: 'Tenant', entityId: t._id, reason: body.reason }, req);
    return t;
  },
);

m.route(
  { method: 'post', path: '/tenants/:id/subscription', summary: 'Change plan / renew subscription', auth: 'platform', body: z.object({ planCode: z.string(), interval: z.enum(['monthly', 'annual']), periods: z.number().int().min(1).max(36).default(1) }) },
  async ({ params, body, ctx, req }) => {
    const plan = await Plan.findOne({ code: body.planCode }).lean();
    if (!plan) throw notFound('Plan');
    const sub = await Subscription.findOne({ tenantId: params.id });
    if (!sub) throw notFound('Subscription');
    const start = sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() && sub.status === 'active' ? sub.currentPeriodEnd : new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + (body.interval === 'annual' ? 12 : 1) * body.periods);
    sub.set({ planId: plan._id, interval: body.interval, status: 'active', currentPeriodStart: start, currentPeriodEnd: end });
    sub.history!.push({ at: new Date(), action: 'renewed', by: ctx.userId, note: `${plan.code} ${body.interval} ×${body.periods}` });
    await sub.save();
    await Tenant.updateOne({ _id: params.id }, { $set: { status: 'active' } });
    invalidateTenantCache(params.id);
    await audit(ctx, { action: 'platform.subscription_renewed', entity: 'Tenant', entityId: params.id, meta: { plan: plan.code, end } }, req);
    return sub;
  },
);

const zPlan = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,30}$/), name: z.string(), description: z.string().optional(), priceMonthly: z.number().int().min(0), priceAnnual: z.number().int().min(0),
  trialDays: z.number().int().min(0).max(90).default(14), limits: z.object({ branches: z.number().int(), users: z.number().int(), terminals: z.number().int(), products: z.number().int() }),
  features: z.array(z.enum(FEATURES)), active: z.boolean().default(true),
});
m.route({ method: 'get', path: '/plans', summary: 'List plans', auth: 'platform' }, async () => Plan.find().sort({ priceMonthly: 1 }).lean());
m.route({ method: 'put', path: '/plans/:code', summary: 'Create or update a plan', auth: 'platform', body: zPlan }, async ({ params, body, ctx, req }) => {
  const plan = await Plan.findOneAndUpdate({ code: params.code }, { $set: { ...body, code: params.code } }, { upsert: true, new: true });
  invalidateTenantCache();
  await audit(ctx, { action: 'platform.plan_saved', entity: 'Plan', entityId: plan._id, after: body }, req);
  return plan;
});

m.route({ method: 'get', path: '/jobs', summary: 'Background job health', auth: 'platform' }, async () => {
  const [jobs, notifications] = await Promise.all([
    Job.aggregate([{ $match: {} }, { $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]).option(G),
    NotificationJob.aggregate([{ $match: { tenantId: { $exists: true } } }, { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 } } }]),
  ]);
  return { jobs, notifications };
});

m.route({ method: 'get', path: '/integrations', summary: 'Integration health across tenants (no secrets)', auth: 'platform' }, async () =>
  IntegrationConfiguration.aggregate([{ $match: { tenantId: { $exists: true } } }, { $group: { _id: { kind: '$kind', state: '$status.state' }, n: { $sum: 1 } } }]),
);

m.route({ method: 'get', path: '/audit', summary: 'Platform audit log', auth: 'platform' }, async () => AuditLog.find({ tenantId: null }).sort({ createdAt: -1 }).limit(200).lean());
m.route({ method: 'get', path: '/support', summary: 'Support tickets', auth: 'platform' }, async () => SupportTicket.find().sort({ createdAt: -1 }).limit(200).lean());
m.route({ method: 'get', path: '/usage', summary: 'Usage per tenant (users, orders last 30d)', auth: 'platform' }, async () => {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [users, orders] = await Promise.all([
    User.aggregate([{ $match: { tenantId: { $ne: null } } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { tenantId: { $exists: true }, createdAt: { $gte: since } } }, { $group: { _id: '$tenantId', n: { $sum: 1 }, revenue: { $sum: '$totals.total' } } }]),
  ]);
  return { users, orders };
});

export { zId };
export default m;
