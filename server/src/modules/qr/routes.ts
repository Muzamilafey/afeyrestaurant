import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { createModule, zId } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import type { BranchContext } from '../../http/context';
import { Branch, Category, DiningArea, ModifierGroup, Order, PaymentAttempt, Product, Table, Tenant } from '../../models';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { emitBranch } from '../../realtime/bus';
import { audit } from '../../services/audit';
import * as svc from '../../services/orders';
import * as pay from '../../services/payments';
import { inWindow, localParts, resolvePrice } from '../../services/pricing';
import { restoreExpiredSoldOut } from '../menu/routes';

/**
 * QR table ordering. Each table has a QR sticker pointing to /t/<token>. The guest sees the menu, orders, calls a
 * waiter or asks for the bill, and can pay the balance by M-Pesa prompt. Orders are tied to that table; with
 * "staff accept" on (the default) a waiter accepts the order before it reaches the kitchen/bar.
 */
const m = createModule('/qr', 'QR table ordering');
/** Orders placed by a guest belong to the table's waiter, or to nobody until a waiter accepts them. */
const { QR_GUEST } = svc;

async function tableByToken(token: string) {
  if (!/^[a-f0-9]{24,64}$/.test(token)) throw notFound('Table');
  const table = await Table.findOne({ qrToken: token, active: true }).setOptions({ skipTenantGuard: true }).lean();
  if (!table) throw notFound('Table');
  const [tenant, branch] = await Promise.all([Tenant.findById(table.tenantId).lean(), Branch.findOne({ tenantId: table.tenantId, _id: table.branchId, active: true }).lean()]);
  if (!tenant || !branch || !branch.settings?.qrOrdering?.enabled) throw new AppError(404, 'QR_ORDERING_OFF', 'Ordering from the table is not available right now — please ask a waiter');
  return { table, tenant, branch };
}
/** The guest acts as the business with no staff permissions; services only see a branch context. */
function guestCtx(t: { tenantId: unknown; branchId: unknown }): BranchContext {
  return { userId: QR_GUEST, userName: 'QR order', email: '', tenantId: t.tenantId as Types.ObjectId, branchId: t.branchId as Types.ObjectId, allowedBranchIds: [t.branchId as Types.ObjectId], allBranches: false, permissions: new Set(), roleKey: null };
}
const guestOrderFilter = (table: { tenantId: unknown; branchId: unknown; _id: unknown }, id: string) => ({ tenantId: table.tenantId, branchId: table.branchId, tableId: table._id, _id: id, source: 'qr', createdAt: { $gt: new Date(Date.now() - 12 * 3600_000) } });

// ── Guest (public) ──

m.route({ method: 'get', path: '/t/:token', summary: 'Guest: menu for this table', auth: 'public' }, async ({ params }) => {
  const { table, tenant, branch } = await tableByToken(params.token);
  await restoreExpiredSoldOut(tenant._id);
  const now = localParts(tenant.settings?.timezone ?? 'Africa/Nairobi');
  const [cats, products, area] = await Promise.all([
    Category.find({ tenantId: tenant._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Product.find({ tenantId: tenant._id, status: 'available', ageRestricted: { $ne: true } }).sort({ sortOrder: 1, name: 1 }).lean(),
    table.areaId ? DiningArea.findOne({ tenantId: tenant._id, _id: table.areaId }).lean() : null,
  ]);
  const visible = products.filter((p) => (!p.availability?.branchIds?.length || p.availability.branchIds.some((b) => String(b) === String(branch._id))) && (!p.availability?.days?.length || p.availability.days.includes(now.day)) && inWindow(now.time, p.availability?.start, p.availability?.end));
  const groups = await ModifierGroup.find({ tenantId: tenant._id, _id: { $in: visible.flatMap((p) => p.modifierGroupIds ?? []) } }).lean();
  return {
    restaurant: tenant.name, branding: { logoUrl: tenant.branding?.logoUrl ?? null, color: tenant.branding?.primaryColor ?? '#07963C' }, branch: branch.name,
    table: { number: table.number, area: area?.name ?? null },
    canPay: branch.settings?.qrOrdering?.payByMpesa !== false, requireAccept: branch.settings?.qrOrdering?.requireAccept !== false,
    categories: cats.filter((c) => visible.some((p) => String(p.categoryId) === String(c._id))).map((c) => ({ id: c._id, name: c.name, icon: c.icon })),
    products: visible.map((p) => {
      const price = resolvePrice(p, { branchId: branch._id, happyHours: branch.settings?.happyHours as never, now });
      return { id: p._id, name: p.name, description: p.description, imageUrl: p.imageUrl, categoryId: p.categoryId, dietary: p.dietary, price: 'price' in price ? price.price : p.price, happyHour: 'happyHour' in price ? price.happyHour : false, variants: p.variants ?? [], modifierGroupIds: p.modifierGroupIds ?? [], isCombo: !!p.combo?.isCombo };
    }),
    modifierGroups: groups.map((g) => ({ id: g._id, name: g.name, minSelect: g.minSelect ?? 0, maxSelect: g.maxSelect ?? 1, options: (g.options ?? []).filter((o) => o.active !== false).map((o) => ({ id: (o as { _id?: Types.ObjectId })._id, name: o.name, priceDelta: o.priceDelta ?? 0 })) })),
  };
});

const zGuestItem = z.object({ productId: zId, qty: z.number().int().min(1).max(20), variant: z.string().max(40).optional(), modifiers: z.array(z.object({ groupId: zId, optionId: zId })).max(20).optional(), notes: z.string().max(200).optional() });

m.route({
  method: 'post', path: '/t/:token/orders', summary: 'Guest: place an order (or add to this table’s QR order)', auth: 'public', status: 201,
  body: z.object({ clientId: z.uuid(), items: z.array(zGuestItem).min(1).max(30), name: z.string().max(60).optional(), orderId: zId.optional() }),
}, async ({ params, body }) => {
  const { table, branch } = await tableByToken(params.token);
  const ctx = guestCtx(table);
  // Simple abuse guard: at most 15 QR orders/additions per table per hour.
  const recent = await Order.countDocuments({ tenantId: table.tenantId, branchId: table.branchId, tableId: table._id, source: 'qr', updatedAt: { $gt: new Date(Date.now() - 3600_000) } });
  if (recent >= 15) throw new AppError(429, 'TOO_MANY_ORDERS', 'Too many orders from this table — please ask a waiter');
  const requireAccept = branch.settings?.qrOrdering?.requireAccept !== false;
  const items = body.items.map((i) => ({ ...i, lineId: crypto.randomUUID() }));
  let order;
  const existing = body.orderId ? await Order.findOne({ ...guestOrderFilter(table, body.orderId), status: { $in: ['open', 'held'] } }) : null;
  if (existing) {
    order = await svc.addItems(ctx, String(existing._id), items, {});
    if (requireAccept) await Order.updateOne({ tenantId: table.tenantId, _id: existing._id }, { $set: { qrPending: true } });
    else order = (await svc.sendToStations(ctx, String(existing._id), `qr:${body.clientId}`)).order;
  } else {
    const r = await svc.createOrder(ctx, { clientId: body.clientId, type: 'dine_in', outlet: 'restaurant', tableId: String(table._id), customerName: body.name, items, source: 'qr', qrPending: requireAccept, waiterId: table.waiterId ?? QR_GUEST, waiterName: table.waiterId ? undefined : 'QR order', sendToStations: !requireAccept } as never);
    order = r.order;
    if (!requireAccept && !r.duplicate) order = (await svc.sendToStations(ctx, String(order._id), `qr:${body.clientId}`)).order;
  }
  emitBranch(table.tenantId, table.branchId, 'qr.order', { orderId: String(order._id), number: order.number, table: table.number, needsAccept: requireAccept });
  emitBranch(table.tenantId, table.branchId, 'order.updated', { id: String(order._id) });
  return guestView(order);
});

function guestView(o: { _id: unknown; number: string; status: string; qrPending?: boolean | null; items: Array<{ lineId: string; name: string; qty: number; lineTotal: number; status: string; voided?: boolean | null; parentLineId?: string | null }>; totals?: { total: number; paid: number } | null }) {
  const t = o.totals ?? { total: 0, paid: 0 };
  return {
    id: String(o._id), number: o.number, status: o.status, waitingForStaff: !!o.qrPending,
    items: o.items.filter((i) => !i.voided && !i.parentLineId).map((i) => ({ name: i.name, qty: i.qty, total: i.lineTotal, status: o.qrPending && i.status === 'new' ? 'waiting' : i.status })),
    total: t.total, paid: t.paid, balance: t.total - t.paid,
  };
}

m.route({ method: 'get', path: '/t/:token/orders/:id', summary: 'Guest: status of their order', auth: 'public' }, async ({ params }) => {
  const { table } = await tableByToken(params.token);
  const o = await Order.findOne(guestOrderFilter(table, params.id)).lean();
  if (!o) throw notFound('Order');
  return guestView(o as never);
});

m.route({ method: 'post', path: '/t/:token/call', summary: 'Guest: call a waiter or ask for the bill', auth: 'public', body: z.object({ reason: z.enum(['waiter', 'bill']) }) }, async ({ params, body }) => {
  const { table } = await tableByToken(params.token);
  if (table.call?.at && Date.now() - new Date(table.call.at).getTime() < 30_000 && table.call.reason === body.reason) return { ok: true, repeated: true };
  await Table.updateOne({ tenantId: table.tenantId, _id: table._id }, { $set: { call: { reason: body.reason, at: new Date() } } });
  emitBranch(table.tenantId, table.branchId, 'table.call', { tableId: String(table._id), table: table.number, reason: body.reason });
  emitBranch(table.tenantId, table.branchId, 'table.updated', { id: String(table._id) });
  return { ok: true };
});

m.route({ method: 'post', path: '/t/:token/orders/:id/mpesa', summary: 'Guest: pay the balance by M-Pesa prompt', auth: 'public', body: z.object({ phone: z.string().min(9).max(16), idempotencyKey: z.string().min(8).max(80) }) }, async ({ params, body }) => {
  const { table, branch } = await tableByToken(params.token);
  if (branch.settings?.qrOrdering?.payByMpesa === false) throw badRequest('Paying from the table is off — please ask for the bill');
  const o = await Order.findOne({ ...guestOrderFilter(table, params.id), status: { $in: ['open', 'held'] } }).lean();
  if (!o) throw notFound('Order');
  if (o.qrPending) throw conflict('Your order is waiting for a waiter to accept it', 'QR_PENDING');
  const balance = (o.totals?.total ?? 0) - (o.totals?.paid ?? 0);
  const amount = balance - (balance % 100); // M-Pesa takes whole shillings
  if (amount <= 0) throw badRequest('Nothing to pay');
  const a = await pay.initiateMpesa(guestCtx(table), String(o._id), { phone: body.phone, amount, idempotencyKey: `qr:${body.idempotencyKey}` });
  return { attemptId: String(a._id), status: a.status, amount };
});

m.route({ method: 'get', path: '/t/:token/orders/:id/mpesa/:attemptId', summary: 'Guest: M-Pesa prompt status', auth: 'public' }, async ({ params }) => {
  const { table } = await tableByToken(params.token);
  if (!Types.ObjectId.isValid(params.attemptId)) throw notFound('Payment');
  const a = await PaymentAttempt.findOne({ tenantId: table.tenantId, _id: params.attemptId, orderId: params.id }).lean();
  if (!a || !(await Order.exists(guestOrderFilter(table, params.id)))) throw notFound('Payment');
  const r = await pay.queryAttempt(table.tenantId as Types.ObjectId, a._id).catch(() => a);
  return { status: r.status, resultDesc: r.resultDesc };
});

// ── Staff ──

m.route({ method: 'post', path: '/orders/:id/accept', summary: 'Accept a guest’s QR order and send it to the kitchen/bar', permission: P.ORDERS_UPDATE }, async ({ ctx, params, req }) => {
  const o = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id, source: 'qr' });
  if (!o) throw notFound('Order');
  if (String(o.waiterId) === String(QR_GUEST)) o.set({ waiterId: ctx.userId, waiterName: ctx.userName });
  o.set('qrPending', undefined);
  await o.save();
  const r = await svc.sendToStations(ctx, String(o._id), `qr-accept:${o._id}:${o.items.length}`);
  await audit(ctx, { action: 'order.qr_accepted', entity: 'Order', entityId: o._id }, req);
  return r.order;
});

m.route({ method: 'post', path: '/tables/:id/call/clear', summary: 'Answer a table’s call (waiter / bill)', permission: P.TABLES_VIEW }, async ({ ctx, params }) => {
  await Table.updateOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $unset: { call: 1 } });
  emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: params.id });
  return { ok: true };
});

/** QR stickers: every table gets a code (created on first use); regenerate to retire a printed sticker. */
m.route({ method: 'get', path: '/codes', summary: 'QR codes for the branch’s tables', permission: P.TABLES_MANAGE }, async ({ ctx }) => {
  const tables = await Table.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, active: true }).sort({ number: 1 });
  const areas = await DiningArea.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean();
  for (const t of tables) if (!t.qrToken) { t.qrToken = crypto.randomBytes(16).toString('hex'); await t.save(); }
  return tables.map((t) => ({ tableId: String(t._id), number: t.number, area: areas.find((a) => String(a._id) === String(t.areaId))?.name ?? null, path: `/t/${t.qrToken}` }));
});
m.route({ method: 'post', path: '/codes/:tableId/regenerate', summary: 'New QR code for a table (old sticker stops working)', permission: P.TABLES_MANAGE }, async ({ ctx, params, req }) => {
  const t = await Table.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.tableId });
  if (!t) throw notFound('Table');
  t.qrToken = crypto.randomBytes(16).toString('hex');
  await t.save();
  await audit(ctx, { action: 'table.qr_regenerated', entity: 'Table', entityId: t._id }, req);
  return { tableId: String(t._id), path: `/t/${t.qrToken}` };
});

export default m;
