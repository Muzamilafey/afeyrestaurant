import { z } from 'zod';
import { createModule } from '../../http/route';
import { KitchenTicket, Order, Branch } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { emitStation, emitBranch } from '../../realtime/bus';
import { notify } from '../../services/notify';

const m = createModule('/stations', 'Kitchen & Bar');

const viewPerm = (s: string) => (s === 'bar' ? P.BAR_VIEW : P.KITCHEN_VIEW);
const updatePerm = (s: string) => (s === 'bar' ? P.BAR_UPDATE : P.KITCHEN_UPDATE);

m.route({ method: 'get', path: '/:station/tickets', summary: 'Active tickets for kitchen or bar display', permission: [P.KITCHEN_VIEW, P.BAR_VIEW], query: z.object({ include: z.enum(['active', 'recent']).default('active') }) }, async ({ ctx, params, query }) => {
  if (!['kitchen', 'bar'].includes(params.station)) throw notFound('Station');
  if (!ctx.permissions.has(viewPerm(params.station))) throw forbidden();
  const branch = await Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }, { settings: 1 }).lean();
  const status = query.include === 'active' ? { $in: ['pending', 'accepted', 'preparing', 'ready'] } : { $in: ['completed', 'cancelled'] };
  const tickets = await KitchenTicket.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, station: params.station, status }).sort({ priority: -1, createdAt: 1 }).limit(query.include === 'active' ? 200 : 50).lean();
  // Kitchen staff only see what they need to cook — no prices or payment information.
  return { delayMinutes: branch?.settings?.kitchenDelayMinutes ?? 15, tickets: tickets.map((t) => ({ ...t, ageSeconds: Math.round((Date.now() - new Date((t as { createdAt: Date }).createdAt).getTime()) / 1000) })) };
});

const NEXT: Record<string, string[]> = { pending: ['accepted', 'preparing', 'cancelled'], accepted: ['preparing', 'ready'], preparing: ['ready'], ready: ['completed'], completed: [], cancelled: [] };
const ITEM_STATUS: Record<string, string> = { accepted: 'accepted', preparing: 'preparing', ready: 'ready', completed: 'served', cancelled: 'cancelled' };

m.route({ method: 'post', path: '/tickets/:id/status', summary: 'Advance a ticket: accepted → preparing → ready → completed', permission: [P.KITCHEN_UPDATE, P.BAR_UPDATE], body: z.object({ status: z.enum(['accepted', 'preparing', 'ready', 'completed', 'cancelled']) }) }, async ({ ctx, params, body }) => {
  const t = await KitchenTicket.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!t) throw notFound('Ticket');
  if (!ctx.permissions.has(updatePerm(t.station))) throw forbidden();
  // Already completed (e.g. cleared automatically when the order was paid): tapping "Served" again is a no-op.
  if (t.status === 'completed' && body.status === 'completed') return t;
  if (!NEXT[t.status].includes(body.status)) throw badRequest(`Cannot move a ${t.status} ticket to ${body.status}`);
  if (body.status === 'cancelled' && !ctx.permissions.has(P.ORDERS_VOID_SENT_ITEM)) throw forbidden('Cancelling a ticket requires manager permission — void the items from the POS');
  const now = new Date();
  t.status = body.status;
  if (body.status === 'accepted') t.acceptedAt = now;
  if (body.status === 'preparing') t.startedAt = now;
  if (body.status === 'ready') t.readyAt = now;
  if (body.status === 'completed') {
    t.completedAt = now;
    t.completedVia = 'station';
  }
  t.handledBy = ctx.userId;
  for (const it of t.items) if (it.status !== 'cancelled') it.status = ITEM_STATUS[body.status];
  await t.save();

  // Mirror status onto the order lines with a targeted update so concurrent POS edits are not clobbered.
  const ids = t.items.filter((i) => i.status !== 'cancelled').map((i) => i.lineId);
  const set: Record<string, unknown> = { 'items.$[l].status': ITEM_STATUS[body.status] };
  if (body.status === 'ready') set['items.$[l].readyAt'] = now;
  if (body.status === 'completed') set['items.$[l].servedAt'] = now;
  await Order.updateOne({ tenantId: ctx.tenantId, _id: t.orderId }, { $set: set }, { arrayFilters: [{ 'l.lineId': { $in: ids }, 'l.voided': { $ne: true } }] });
  const order = await Order.findOne({ tenantId: ctx.tenantId, _id: t.orderId }).lean();
  if (order) {
    emitBranch(ctx.tenantId, ctx.branchId, 'order.updated', { id: String(order._id), number: order.number });
    const allReady = order.items.filter((i) => !i.voided && i.station !== 'none').every((i) => ['ready', 'served'].includes(i.status));
    if (body.status === 'ready' && allReady && order.customerPhone && ['takeaway', 'online', 'delivery'].includes(order.type)) {
      await notify(ctx.tenantId, { event: 'order_ready', channel: 'sms', to: order.customerPhone, vars: { customer_name: order.customerName ?? 'there', order_number: order.number }, dedupeKey: `ready:${order._id}`, refType: 'Order', refId: order._id }).catch(() => undefined);
    }
  }
  emitStation(ctx.tenantId, ctx.branchId, t.station, 'ticket.updated', { id: String(t._id), status: t.status });
  return t;
});

export default m;
