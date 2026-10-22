import { z } from 'zod';
import { createModule, zId } from '../../http/route';
import { Table, DiningArea, Order } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { notFound, conflict } from '../../lib/errors';
import { emitBranch } from '../../realtime/bus';

const m = createModule('/tables', 'Tables');

m.route({ method: 'get', path: '', summary: 'Floor plan: areas, tables and their open orders', permission: P.TABLES_VIEW }, async ({ ctx }) => {
  const [areas, tables, orders] = await Promise.all([
    DiningArea.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ sortOrder: 1 }).lean(),
    Table.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, active: true }).sort({ number: 1 }).lean(),
    Order.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, status: { $in: ['open', 'held'] } }, { number: 1, tableId: 1, status: 1, waiterName: 1, totals: 1, items: 1, createdAt: 1, type: 1, guests: 1 }).lean(),
  ]);
  return {
    areas,
    tables: tables.map((t) => {
      const os = orders.filter((o) => String(o.tableId) === String(t._id));
      const items = os.flatMap((o) => o.items.filter((i) => !i.voided));
      const done = items.filter((i) => ['ready', 'served'].includes(i.status)).length;
      return { ...t, orders: os.map((o) => ({ id: String(o._id), number: o.number, status: o.status, waiterName: o.waiterName, total: o.totals?.total ?? 0, itemCount: o.items.filter((i) => !i.voided).length })), itemCount: items.length, progress: items.length ? done / items.length : 0 };
    }),
    takeaway: orders.filter((o) => !o.tableId).map((o) => ({ id: String(o._id), number: o.number, type: o.type, status: o.status, waiterName: o.waiterName, total: o.totals?.total ?? 0, itemCount: o.items.filter((i) => !i.voided).length, progress: (() => { const it = o.items.filter((i) => !i.voided); return it.length ? it.filter((i) => ['ready', 'served'].includes(i.status)).length / it.length : 0; })() })),
  };
});

const zTable = z.object({ number: z.string().min(1).max(10), capacity: z.number().int().min(1).max(50), areaId: zId.optional(), shape: z.enum(['square', 'round', 'rect']).optional(), layout: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(), active: z.boolean().optional() });
m.route({ method: 'post', path: '', summary: 'Create a table', permission: P.TABLES_MANAGE, body: zTable, status: 201 }, async ({ ctx, body }) => Table.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));
m.route({ method: 'patch', path: '/:id', summary: 'Update a table / layout position', permission: P.TABLES_MANAGE, body: zTable.partial() }, async ({ ctx, params, body }) => {
  const t = await Table.findOneAndUpdate({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $set: body }, { new: true });
  if (!t) throw notFound('Table');
  emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: params.id });
  return t;
});
m.route({ method: 'post', path: '/:id/status', summary: 'Set table status (cleaning → available, reserved)', permission: P.TABLES_VIEW, body: z.object({ status: z.enum(['available', 'reserved', 'cleaning']), waiterId: zId.optional() }) }, async ({ ctx, params, body }) => {
  const t = await Table.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!t) throw notFound('Table');
  const open = await Order.countDocuments({ tenantId: ctx.tenantId, branchId: ctx.branchId, tableId: t._id, status: { $in: ['open', 'held'] } });
  if (open && body.status !== 'reserved') throw conflict('Table has open orders', 'TABLE_OCCUPIED');
  t.status = body.status;
  if (body.waiterId) t.waiterId = body.waiterId as never;
  await t.save();
  emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: params.id });
  return t;
});
m.route({ method: 'post', path: '/:id/assign', summary: 'Assign a waiter to a table', permission: P.TABLES_MANAGE, body: z.object({ waiterId: zId }) }, async ({ ctx, params, body }) => {
  const t = await Table.findOneAndUpdate({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $set: { waiterId: body.waiterId } }, { new: true });
  if (!t) throw notFound('Table');
  return t;
});
m.route({ method: 'get', path: '/areas', summary: 'Dining areas', permission: P.TABLES_VIEW }, async ({ ctx }) => DiningArea.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/areas', summary: 'Create a dining area', permission: P.TABLES_MANAGE, body: z.object({ name: z.string().min(1).max(40), sortOrder: z.number().int().optional() }), status: 201 }, async ({ ctx, body }) => DiningArea.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));

export default m;
