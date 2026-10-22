import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createModule, zId, zMoney } from '../../http/route';
import { Customer, CustomerNote, LoyaltyAccount, LoyaltyTransaction, Coupon, Feedback, Order, Reservation, Table, DeliveryZone, Rider, Tenant, Branch } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { normalizeKePhone } from '../../lib/phone';
import { audit } from '../../services/audit';
import { notify } from '../../services/notify';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { localParts } from '../../services/pricing';
import { emitBranch } from '../../realtime/bus';
import { mutateOrder } from '../../services/orders';

const m = createModule('/crm', 'Customers, Reservations & Delivery');

// ── Customers ──
const zCustomer = z.object({
  name: z.string().min(1).max(80), phone: z.string().max(20).optional(), email: z.email().optional(), birthday: z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).optional(), tags: z.array(z.string().max(20)).max(10).optional(),
  consent: z.object({ marketingSms: z.boolean(), marketingEmail: z.boolean(), birthdayOffers: z.boolean() }).partial().optional(),
});
m.route({ method: 'get', path: '/customers', summary: 'Search customers', permission: P.CUSTOMERS_VIEW, query: z.object({ q: z.string().max(60).optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId, active: true };
  if (query.q) {
    const phone = normalizeKePhone(query.q);
    f.$or = phone ? [{ phone }] : [{ name: new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { email: query.q.toLowerCase() }];
  }
  return Customer.find(f).sort({ lastVisitAt: -1 }).limit(100).lean();
});
m.route({ method: 'post', path: '/customers', summary: 'Create customer', permission: P.CUSTOMERS_MANAGE, body: zCustomer, status: 201 }, async ({ ctx, body }) => {
  const phone = body.phone ? normalizeKePhone(body.phone) : undefined;
  if (body.phone && !phone) throw badRequest('Invalid phone number');
  if (phone && (await Customer.exists({ tenantId: ctx.tenantId, phone }))) throw conflict('A customer with this phone already exists');
  return Customer.create({ ...body, phone, tenantId: ctx.tenantId, consent: { ...body.consent, updatedAt: new Date(), source: 'staff' } });
});
m.route({ method: 'get', path: '/customers/:id', summary: 'Customer profile with history and loyalty', permission: P.CUSTOMERS_VIEW }, async ({ ctx, params }) => {
  const c = await Customer.findOne({ tenantId: ctx.tenantId, _id: params.id }).lean();
  if (!c) throw notFound('Customer');
  const [orders, loyalty, txs, reservations, notes] = await Promise.all([
    Order.find({ tenantId: ctx.tenantId, customerId: c._id }, { number: 1, status: 1, totals: 1, createdAt: 1, type: 1, branchId: 1 }).sort({ createdAt: -1 }).limit(50).lean(),
    LoyaltyAccount.findOne({ tenantId: ctx.tenantId, customerId: c._id }).lean(),
    LoyaltyTransaction.find({ tenantId: ctx.tenantId, customerId: c._id }).sort({ createdAt: -1 }).limit(50).lean(),
    Reservation.find({ tenantId: ctx.tenantId, customerId: c._id }).sort({ startsAt: -1 }).limit(20).lean(),
    ctx.permissions.has(P.CUSTOMERS_NOTES) ? CustomerNote.find({ tenantId: ctx.tenantId, customerId: c._id }).sort({ createdAt: -1 }).lean() : Promise.resolve(null),
  ]);
  return { customer: c, orders, loyalty, loyaltyTransactions: txs, reservations, notes };
});
m.route({ method: 'patch', path: '/customers/:id', summary: 'Update customer & communication preferences', permission: P.CUSTOMERS_MANAGE, body: zCustomer.partial() }, async ({ ctx, params, body, req }) => {
  const c = await Customer.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!c) throw notFound('Customer');
  const { consent, phone, ...rest } = body;
  c.set(rest);
  if (phone !== undefined) {
    const n = normalizeKePhone(phone);
    if (!n) throw badRequest('Invalid phone number');
    c.phone = n;
  }
  if (consent) {
    c.set('consent', { ...(c.toObject().consent ?? {}), ...consent, updatedAt: new Date(), source: 'staff' });
    await audit(ctx, { action: 'customer.consent_changed', entity: 'Customer', entityId: c._id, after: consent }, req);
  }
  await c.save();
  return c;
});
/** Data subject erasure: anonymise personal data while keeping financial records intact. */
m.route({ method: 'post', path: '/customers/:id/anonymise', summary: 'Anonymise a customer (right to erasure)', permission: P.CUSTOMERS_MANAGE, body: z.object({ reason: z.string().min(3).max(200) }) }, async ({ ctx, params, body, req }) => {
  const c = await Customer.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!c) throw notFound('Customer');
  if ((c.credit?.balance ?? 0) > 0) throw conflict('Customer has an outstanding credit balance');
  c.set({ name: 'Anonymised customer', phone: undefined, email: undefined, birthday: undefined, tags: [], active: false, consent: { marketingSms: false, marketingEmail: false, birthdayOffers: false, updatedAt: new Date(), source: 'erasure' } });
  await c.save();
  await CustomerNote.deleteMany({ tenantId: ctx.tenantId, customerId: c._id });
  await Order.updateMany({ tenantId: ctx.tenantId, customerId: c._id }, { $set: { customerName: 'Anonymised', customerPhone: null } });
  await audit(ctx, { action: 'customer.anonymised', entity: 'Customer', entityId: c._id, reason: body.reason }, req);
  return { ok: true };
});
m.route({ method: 'post', path: '/customers/:id/notes', summary: 'Add a restricted note', permission: P.CUSTOMERS_NOTES, body: z.object({ note: z.string().min(1).max(1000) }), status: 201 }, async ({ ctx, params, body }) => {
  if (!(await Customer.exists({ tenantId: ctx.tenantId, _id: params.id }))) throw notFound('Customer');
  return CustomerNote.create({ tenantId: ctx.tenantId, customerId: params.id, note: body.note, by: ctx.userId });
});
m.route({ method: 'post', path: '/customers/:id/credit', summary: 'Approve/adjust a customer credit account', permission: P.PAYMENTS_CREDIT_SALE, body: z.object({ approved: z.boolean(), limit: zMoney }) }, async ({ ctx, params, body, req }) => {
  const c = await Customer.findOneAndUpdate({ tenantId: ctx.tenantId, _id: params.id }, { $set: { 'credit.approved': body.approved, 'credit.limit': body.limit, 'credit.approvedBy': ctx.userId } }, { new: true });
  if (!c) throw notFound('Customer');
  await audit(ctx, { action: 'customer.credit_updated', entity: 'Customer', entityId: c._id, after: body }, req);
  return c;
});
m.route({ method: 'post', path: '/customers/:id/loyalty/redeem', summary: 'Redeem loyalty points as an order discount', permission: P.ORDERS_UPDATE, body: z.object({ orderId: zId, points: z.number().int().positive() }) }, async ({ ctx, params, body, req }) => {
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  const value = body.points * (tenant?.settings?.loyaltyRedeemValue ?? 100);
  const acct = await LoyaltyAccount.findOneAndUpdate({ tenantId: ctx.tenantId, customerId: params.id, points: { $gte: body.points } }, { $inc: { points: -body.points } }, { new: true });
  if (!acct) throw conflict('Not enough loyalty points');
  try {
    const order = await mutateOrder(ctx, body.orderId, async (o) => {
      if ((o.discount?.type ?? 'none') !== 'none') throw conflict('Order already has a discount');
      o.set('discount', { type: 'amount', value: value, reason: `Loyalty redemption (${body.points} pts)` });
      const { recalc } = await import('../../services/orders');
      await recalc(o);
    });
    await LoyaltyTransaction.create({ tenantId: ctx.tenantId, customerId: params.id, type: 'redeem', points: -body.points, orderId: order._id, idempotencyKey: `redeem:${order._id}` });
    await audit(ctx, { action: 'loyalty.redeemed', entity: 'Order', entityId: order._id, meta: { points: body.points, value } }, req);
    return order;
  } catch (e) {
    await LoyaltyAccount.updateOne({ tenantId: ctx.tenantId, customerId: params.id }, { $inc: { points: body.points } });
    throw e;
  }
});

// ── Coupons & feedback ──
m.route({ method: 'get', path: '/coupons', summary: 'Coupons', permission: P.LOYALTY_MANAGE }, async ({ ctx }) => Coupon.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).lean());
m.route({ method: 'post', path: '/coupons', summary: 'Create coupon', permission: P.LOYALTY_MANAGE, body: z.object({ code: z.string().regex(/^[A-Za-z0-9]{3,20}$/), type: z.enum(['percent', 'amount']), value: z.number().positive(), minSpend: zMoney.optional(), validFrom: z.coerce.date().optional(), validTo: z.coerce.date().optional(), maxUses: z.number().int().positive().optional() }), status: 201 }, async ({ ctx, body }) => {
  if (body.type === 'percent' && body.value > 100) throw badRequest('Percent cannot exceed 100');
  return Coupon.create({ ...body, tenantId: ctx.tenantId });
});
m.route({ method: 'post', path: '/feedback', summary: 'Record customer feedback', permission: P.ORDERS_VIEW, body: z.object({ orderId: zId.optional(), customerId: zId.optional(), rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }), status: 201 }, async ({ ctx, body }) => Feedback.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));
m.route({ method: 'get', path: '/feedback', summary: 'Feedback list', permission: P.CUSTOMERS_VIEW }, async ({ ctx }) => Feedback.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ createdAt: -1 }).limit(200).lean());

// ── Reservations ──
const zReservation = z.object({ customerId: zId.optional(), customerName: z.string().min(1).max(80), phone: z.string().max(20).optional(), email: z.email().optional(), partySize: z.number().int().min(1).max(200), startsAt: z.coerce.date(), durationMinutes: z.number().int().min(15).max(600).optional(), tableIds: z.array(zId).optional(), specialRequests: z.string().max(500).optional(), source: z.enum(['phone', 'walk_in', 'online', 'staff']).optional(), notify: z.boolean().default(true) });

async function checkTableClash(ctx: { tenantId: unknown; branchId: unknown }, tableIds: string[] | undefined, start: Date, minutes: number, excludeId?: unknown) {
  if (!tableIds?.length) return;
  const end = new Date(start.getTime() + minutes * 60_000);
  const clashes = await Reservation.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, tableIds: { $in: tableIds }, status: { $in: ['pending', 'confirmed', 'seated'] }, startsAt: { $lt: end, $gte: new Date(start.getTime() - 12 * 3600_000) }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean();
  const clash = clashes.find((r) => new Date(r.startsAt.getTime() + (r.durationMinutes ?? 90) * 60_000) > start);
  if (clash) throw conflict(`Table already reserved (${clash.code}) at that time`, 'RESERVATION_CLASH');
}

async function sendReservationNotice(ctx: { tenantId: never }, r: { _id: unknown; code: string; customerName: string; phone?: string | null; email?: string | null; partySize: number; startsAt: Date }, event: 'reservation_confirmation' | 'reservation_cancellation') {
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  const lp = localParts(tenant?.settings?.timezone ?? 'Africa/Nairobi', r.startsAt);
  const vars = { customer_name: r.customerName, reservation_date: lp.date, reservation_time: lp.time, guest_count: r.partySize, reservation_code: r.code };
  if (r.phone) await notify(ctx.tenantId, { event, channel: 'sms', to: r.phone, vars, dedupeKey: `${event}:${r._id}:sms` });
  if (r.email && event === 'reservation_confirmation') await notify(ctx.tenantId, { event, channel: 'email', to: r.email, vars, dedupeKey: `${event}:${r._id}:email` });
}

m.route({ method: 'get', path: '/reservations', summary: 'Reservations for a date range', permission: P.RESERVATIONS_VIEW, query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
  const from = query.from ?? new Date(new Date().setHours(0, 0, 0, 0));
  const to = query.to ?? new Date(from.getTime() + 7 * 86400_000);
  return Reservation.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, startsAt: { $gte: from, $lte: to }, ...(query.status ? { status: { $in: query.status.split(',') } } : {}) }).sort({ startsAt: 1 }).lean();
});
m.route({ method: 'post', path: '/reservations', summary: 'Create reservation (sends confirmation)', permission: P.RESERVATIONS_MANAGE, body: zReservation, status: 201 }, async ({ ctx, body }) => {
  if (body.startsAt.getTime() < Date.now() - 15 * 60_000 && body.source !== 'walk_in') throw badRequest('Reservation time is in the past');
  if (body.tableIds?.length) {
    const tables = await Table.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: { $in: body.tableIds } }).lean();
    if (tables.length !== body.tableIds.length) throw notFound('Table');
    if (tables.reduce((s, t) => s + (t.capacity ?? 0), 0) < body.partySize) throw badRequest('Selected tables cannot seat the party');
  }
  await checkTableClash(ctx, body.tableIds, body.startsAt, body.durationMinutes ?? 90);
  const phone = body.phone ? normalizeKePhone(body.phone) ?? undefined : undefined;
  const r = await Reservation.create({ ...body, phone, tenantId: ctx.tenantId, branchId: ctx.branchId, code: `R${randomUUID().slice(0, 6).toUpperCase()}`, createdBy: ctx.userId, status: body.source === 'walk_in' ? 'seated' : 'confirmed' });
  if (body.notify && body.source !== 'walk_in') await sendReservationNotice(ctx as never, r, 'reservation_confirmation');
  emitBranch(ctx.tenantId, ctx.branchId, 'reservation.updated', { id: String(r._id) });
  return r;
});
m.route({ method: 'post', path: '/reservations/:id/status', summary: 'Seat / complete / cancel / no-show', permission: P.RESERVATIONS_MANAGE, body: z.object({ status: z.enum(['confirmed', 'seated', 'completed', 'cancelled', 'no_show']), notify: z.boolean().default(true) }) }, async ({ ctx, params, body }) => {
  const r = await Reservation.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!r) throw notFound('Reservation');
  r.status = body.status;
  await r.save();
  if (body.status === 'seated' && r.tableIds?.length) await Table.updateMany({ tenantId: ctx.tenantId, _id: { $in: r.tableIds }, status: { $in: ['available', 'reserved'] } }, { $set: { status: 'occupied', occupiedSince: new Date() } });
  if (body.status === 'cancelled' && body.notify) await sendReservationNotice(ctx as never, r, 'reservation_cancellation');
  emitBranch(ctx.tenantId, ctx.branchId, 'reservation.updated', { id: String(r._id) });
  return r;
});
m.route({ method: 'patch', path: '/reservations/:id', summary: 'Edit reservation', permission: P.RESERVATIONS_MANAGE, body: zReservation.partial() }, async ({ ctx, params, body }) => {
  const r = await Reservation.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!r) throw notFound('Reservation');
  await checkTableClash(ctx, body.tableIds ?? r.tableIds.map(String), body.startsAt ?? r.startsAt, body.durationMinutes ?? r.durationMinutes ?? 90, r._id);
  const { notify: _n, ...rest } = body;
  r.set(rest);
  await r.save();
  return r;
});

// ── Delivery ──
m.route({ method: 'get', path: '/delivery', summary: 'Active delivery orders', permission: P.DELIVERY_VIEW }, async ({ ctx }) => Order.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, type: { $in: ['delivery', 'online'] }, 'delivery.status': { $nin: ['delivered', 'cancelled'] }, status: { $ne: 'voided' } }).sort({ createdAt: 1 }).limit(200).lean());
m.route({ method: 'post', path: '/delivery/:orderId', summary: 'Assign rider / update delivery status', permission: P.DELIVERY_MANAGE, body: z.object({ riderId: zId.optional(), status: z.enum(['pending', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled']).optional(), estimatedReadyAt: z.coerce.date().optional() }) }, async ({ ctx, params, body }) => {
  const rider = body.riderId ? await Rider.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.riderId, active: true }).lean() : null;
  if (body.riderId && !rider) throw notFound('Rider');
  const o = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.orderId, type: { $in: ['delivery', 'online'] } });
  if (!o) throw notFound('Delivery order');
  if (rider) o.set({ 'delivery.riderId': rider._id, 'delivery.riderName': rider.name, 'delivery.status': body.status ?? 'assigned' });
  if (body.status) o.set('delivery.status', body.status);
  if (body.status === 'delivered') o.set('delivery.deliveredAt', new Date());
  if (body.estimatedReadyAt) o.set('delivery.estimatedReadyAt', body.estimatedReadyAt);
  await o.save();
  if (body.status && o.customerPhone) {
    const label: Record<string, string> = { assigned: 'assigned to a rider', picked_up: 'on its way', delivered: 'delivered', failed: 'delayed — we will call you', cancelled: 'cancelled', pending: 'being prepared' };
    await notify(ctx.tenantId, { event: 'delivery_update', channel: 'sms', to: o.customerPhone, vars: { customer_name: o.customerName ?? 'there', order_number: o.number, delivery_status: label[body.status], tracking_code: o.delivery?.trackingCode }, dedupeKey: `delivery:${o._id}:${body.status}` }).catch(() => undefined);
  }
  emitBranch(ctx.tenantId, ctx.branchId, 'order.updated', { id: String(o._id) });
  return o;
});
m.route({ method: 'get', path: '/delivery-zones', summary: 'Delivery zones', permission: P.DELIVERY_VIEW }, async ({ ctx }) => DeliveryZone.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/delivery-zones', summary: 'Create delivery zone', permission: P.DELIVERY_MANAGE, body: z.object({ name: z.string().min(1).max(60), fee: zMoney, minOrder: zMoney.optional(), etaMinutes: z.number().int().min(5).max(240).optional() }), status: 201 }, async ({ ctx, body }) => DeliveryZone.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));
m.route({ method: 'get', path: '/riders', summary: 'Riders', permission: P.DELIVERY_VIEW }, async ({ ctx }) => Rider.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/riders', summary: 'Add rider', permission: P.DELIVERY_MANAGE, body: z.object({ name: z.string().min(1).max(60), phone: z.string().max(20).optional() }), status: 201 }, async ({ ctx, body }) => Rider.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));

// ── Public: online menu & order tracking (no auth, minimal data) ──
const pub = createModule('/public', 'Public');
pub.route({ method: 'get', path: '/:tenantSlug/track/:code', summary: 'Customer order tracking by code', auth: 'public' }, async ({ params }) => {
  const t = await Tenant.findOne({ slug: params.tenantSlug.toLowerCase() }, { _id: 1, name: 1 }).lean();
  if (!t) throw notFound('Order');
  const o = await Order.findOne({ tenantId: t._id, 'delivery.trackingCode': params.code.toUpperCase() }, { number: 1, status: 1, 'delivery.status': 1, 'delivery.estimatedReadyAt': 1, items: 1, createdAt: 1 }).lean();
  if (!o) throw notFound('Order');
  const items = o.items.filter((i) => !i.voided);
  return { restaurant: t.name, number: o.number, status: o.status, deliveryStatus: o.delivery?.status, estimatedReadyAt: o.delivery?.estimatedReadyAt, ready: items.length > 0 && items.every((i) => ['ready', 'served'].includes(i.status)) };
});
pub.route({ method: 'get', path: '/:tenantSlug/menu/:branchCode', summary: 'Public online menu for a branch', auth: 'public' }, async ({ params }) => {
  const t = await Tenant.findOne({ slug: params.tenantSlug.toLowerCase(), status: { $in: ['active', 'trial'] } }, { _id: 1, name: 1, branding: 1 }).lean();
  if (!t) throw notFound('Menu');
  const b = await Branch.findOne({ tenantId: t._id, code: params.branchCode.toUpperCase(), active: true }).lean();
  if (!b || !(b.settings?.enabledModes ?? []).includes('online')) throw notFound('Menu');
  const { Product, Category } = await import('../../models');
  const [cats, products] = await Promise.all([Category.find({ tenantId: t._id, active: true }).sort({ sortOrder: 1 }).lean(), Product.find({ tenantId: t._id, status: 'available', ageRestricted: { $ne: true }, $or: [{ 'availability.branchIds': { $size: 0 } }, { 'availability.branchIds': b._id }] }, { name: 1, description: 1, imageUrl: 1, price: 1, categoryId: 1, dietary: 1, allergens: 1, branchPrices: 1 }).lean()]);
  return { restaurant: t.name, branding: t.branding, branch: b.name, categories: cats.map((c) => ({ id: c._id, name: c.name, icon: c.icon })), products: products.map((p) => ({ id: p._id, name: p.name, description: p.description, imageUrl: p.imageUrl, categoryId: p.categoryId, dietary: p.dietary, allergens: p.allergens, price: p.branchPrices?.find((x) => String(x.branchId) === String(b._id))?.price ?? p.price })) };
});

export { pub as publicModule, forbidden };
export default m;
