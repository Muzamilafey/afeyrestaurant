import { z } from 'zod';
import { Types } from 'mongoose';
import { createModule } from '../../http/route';
import { Order, Payment, Refund, KitchenTicket, Table, CashSession, Tenant, Branch, PaymentAttempt } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { forbidden } from '../../lib/errors';
import { lowStockItems } from '../inventory/routes';

/**
 * Owner/manager dashboard: headline KPIs against the previous equal period, the sales trend, what is happening on
 * the floor right now and what needs attention. One request so the screen paints at once.
 */
import { startOfDay } from '../../lib/time';

const m = createModule('/dashboard', 'Dashboard');

const DAY = 86400_000;

const RANGES = ['today', 'yesterday', '7d', '30d'] as const;
type Range = (typeof RANGES)[number];

function periods(range: Range, now: Date, tz: string) {
  const midnight = startOfDay(now, tz);
  switch (range) {
    case 'today': // so far today vs the same hours yesterday
      return { from: midnight, to: now, prevFrom: new Date(midnight.getTime() - DAY), prevTo: new Date(now.getTime() - DAY), hourly: true, days: 1 };
    case 'yesterday':
      return { from: new Date(midnight.getTime() - DAY), to: midnight, prevFrom: new Date(midnight.getTime() - 2 * DAY), prevTo: new Date(midnight.getTime() - DAY), hourly: true, days: 1 };
    default: {
      const days = range === '7d' ? 7 : 30;
      const from = new Date(midnight.getTime() - (days - 1) * DAY);
      return { from, to: now, prevFrom: new Date(from.getTime() - days * DAY), prevTo: new Date(now.getTime() - days * DAY), hourly: false, days };
    }
  }
}

m.route(
  {
    method: 'get', path: '/', summary: 'Owner dashboard: KPIs vs previous period, trend, live floor status, alerts', auth: 'tenant', permission: P.REPORTS_SALES,
    query: z.object({ range: z.enum(RANGES).default('today'), branchId: z.string().optional() }),
  },
  async ({ ctx, query }) => {
    // Branch scope: the active branch, one assigned branch, or "all" for users with access to every branch.
    let branchIds: Types.ObjectId[];
    if (query.branchId === 'all') {
      if (!ctx.allBranches) throw forbidden('Business-wide figures require access to all branches');
      branchIds = ctx.allowedBranchIds;
    } else if (query.branchId) {
      if (!ctx.allowedBranchIds.some((b) => String(b) === query.branchId)) throw forbidden('You are not assigned to this branch');
      branchIds = [new Types.ObjectId(query.branchId)];
    } else branchIds = ctx.branchId ? [ctx.branchId] : ctx.allowedBranchIds;

    const tenant = await Tenant.findById(ctx.tenantId).lean();
    const tz = tenant?.settings?.timezone ?? 'Africa/Nairobi';
    const now = new Date();
    const p = periods(query.range, now, tz);
    const base = { tenantId: ctx.tenantId, branchId: { $in: branchIds } };
    const paid = (from: Date, to: Date) => ({ ...base, status: 'paid', paidAt: { $gte: from, $lt: to } });

    const summary = async (from: Date, to: Date) => {
      const [s] = await Order.aggregate([
        { $match: paid(from, to) },
        { $group: { _id: null, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 }, guests: { $sum: { $ifNull: ['$guests', 0] } }, discounts: { $sum: '$totals.discount' }, tax: { $sum: { $add: [{ $ifNull: ['$totals.taxInclusive', 0] }, { $ifNull: ['$totals.taxExclusive', 0] }] } } } },
      ]);
      const revenue = s?.revenue ?? 0;
      const orders = s?.orders ?? 0;
      return { revenue, orders, guests: s?.guests ?? 0, aov: orders ? Math.round(revenue / orders) : 0, discounts: s?.discounts ?? 0, tax: s?.tax ?? 0 };
    };

    // Trend buckets: hours of the day for a single day, otherwise calendar days — aligned with the previous period.
    const bucket = p.hourly ? { $hour: { date: '$paidAt', timezone: tz } } : { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: tz } };
    const series = (from: Date, to: Date) => Order.aggregate<{ _id: number | string; revenue: number; orders: number }>([{ $match: paid(from, to) }, { $group: { _id: bucket, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }]);

    const [cur, prev, curSeries, prevSeries, hourly, payments, byType, topItems, staff, refunds, voids, byOutlet] = await Promise.all([
      summary(p.from, p.to),
      summary(p.prevFrom, p.prevTo),
      series(p.from, p.to),
      series(p.prevFrom, p.prevTo),
      Order.aggregate([{ $match: paid(p.from, p.to) }, { $group: { _id: { $hour: { date: '$paidAt', timezone: tz } }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: p.from, $lt: p.to } } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }]),
      Order.aggregate([{ $match: paid(p.from, p.to) }, { $group: { _id: '$type', revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
      Order.aggregate([
        { $match: paid(p.from, p.to) }, { $unwind: '$items' }, { $match: { 'items.voided': { $ne: true } } },
        { $group: { _id: '$items.productId', name: { $first: '$items.name' }, qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' } } },
        { $sort: { revenue: -1 } }, { $limit: 6 },
      ]),
      Order.aggregate([{ $match: { ...paid(p.from, p.to), waiterName: { $ne: null } } }, { $group: { _id: '$waiterId', name: { $first: '$waiterName' }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }, { $limit: 5 }]),
      Refund.aggregate([{ $match: { ...base, createdAt: { $gte: p.from, $lt: p.to } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { ...base, updatedAt: { $gte: p.from, $lt: p.to } } }, { $unwind: '$items' }, { $match: { 'items.voided': true } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $multiply: ['$items.qty', '$items.unitPrice'] } } } }]),
      Order.aggregate([{ $match: paid(p.from, p.to) }, { $group: { _id: { $ifNull: ['$outlet', { $cond: [{ $eq: ['$type', 'bar_counter'] }, 'bar', 'restaurant'] }] }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    ]);

    // Align current and previous buckets by position (hour 0–23, or day 1..n of the period).
    const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const trend = p.hourly
      ? Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${String(h).padStart(2, '0')}:00`, current: curSeries.find((x) => x._id === h)?.revenue ?? 0, orders: curSeries.find((x) => x._id === h)?.orders ?? 0, previous: prevSeries.find((x) => x._id === h)?.revenue ?? 0 }))
          // today: stop at the current hour so the line does not drop to zero for hours that have not happened yet
          .filter((x) => query.range !== 'today' || x.key <= Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now)))
      : Array.from({ length: p.days }, (_, i) => {
          const d = new Date(p.from.getTime() + i * DAY + 12 * 3600_000);
          const pd = new Date(p.prevFrom.getTime() + i * DAY + 12 * 3600_000);
          return {
            key: dayKey(d),
            label: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: p.days <= 7 ? 'short' : undefined, day: 'numeric', month: 'short' }).format(d),
            current: curSeries.find((x) => x._id === dayKey(d))?.revenue ?? 0,
            orders: curSeries.find((x) => x._id === dayKey(d))?.orders ?? 0,
            previous: prevSeries.find((x) => x._id === dayKey(pd))?.revenue ?? 0,
          };
        });

    // Right now on the floor (independent of the selected range).
    const branches = await Branch.find({ tenantId: ctx.tenantId, _id: { $in: branchIds } }, { name: 1, settings: 1 }).lean();
    const delay = Math.max(1, Math.min(...branches.map((b) => b.settings?.kitchenDelayMinutes ?? 15)));
    const [openOrders, tables, tickets, delayed, drawers, pendingMpesa] = await Promise.all([
      Order.aggregate([{ $match: { ...base, status: { $in: ['open', 'held'] } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$totals.total' } } }]),
      Table.aggregate([{ $match: { ...base, active: { $ne: false } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      KitchenTicket.aggregate([{ $match: { ...base, status: { $in: ['pending', 'accepted', 'preparing', 'ready'] } } }, { $group: { _id: '$station', count: { $sum: 1 } } }]),
      KitchenTicket.countDocuments({ ...base, status: { $in: ['pending', 'accepted', 'preparing'] }, createdAt: { $lt: new Date(now.getTime() - delay * 60_000) } }),
      CashSession.countDocuments({ ...base, status: 'open' }),
      PaymentAttempt.countDocuments({ ...base, status: { $in: ['initiated', 'pending'] } }),
    ]);
    const tableTotal = tables.reduce((a, t) => a + t.count, 0);

    // M-Pesa codes typed in while a till was offline and not yet matched to Safaricom's confirmation.
    const [unconfirmed] = await Payment.aggregate([{ $match: { ...base, method: 'mpesa', status: 'provisional' } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' }, reused: { $sum: { $cond: [{ $ifNull: ['$claimedReference', false] }, 1, 0] } } } }]);
    const canStock = ctx.permissions.has(P.INVENTORY_VIEW) || ctx.permissions.has(P.REPORTS_INVENTORY);
    const lowStock = canStock ? (await Promise.all(branchIds.map((b) => lowStockItems(ctx.tenantId, b)))).flat() : [];

    return {
      range: { key: query.range, from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo, granularity: p.hourly ? 'hour' : 'day', timezone: tz },
      branches: branches.map((b) => ({ id: String(b._id), name: b.name })),
      kpis: { current: cur, previous: prev },
      trend,
      hourly: hourly.map((h) => ({ hour: h._id as number, revenue: h.revenue, orders: h.orders })),
      payments: payments.map((x) => ({ method: x._id as string, amount: x.amount, count: x.count })),
      byType: byType.map((x) => ({ type: x._id as string, revenue: x.revenue, orders: x.orders })),
      byOutlet: byOutlet.map((x) => ({ outlet: x._id as string, revenue: x.revenue, orders: x.orders })),
      topItems: topItems.map((x) => ({ name: x.name, qty: x.qty, revenue: x.revenue })),
      staff: staff.map((x) => ({ name: x.name, revenue: x.revenue, orders: x.orders })),
      live: {
        openOrders: openOrders[0]?.count ?? 0,
        openOrdersValue: openOrders[0]?.value ?? 0,
        tables: { total: tableTotal, occupied: tables.filter((t) => t._id === 'occupied').reduce((a, t) => a + t.count, 0), byStatus: Object.fromEntries(tables.map((t) => [t._id, t.count])) },
        kitchen: tickets.find((t) => t._id === 'kitchen')?.count ?? 0,
        bar: tickets.find((t) => t._id === 'bar')?.count ?? 0,
        delayedTickets: delayed,
        delayMinutes: delay,
        openDrawers: drawers,
        pendingMpesa,
      },
      attention: {
        lowStock: lowStock.slice(0, 6),
        lowStockCount: lowStock.length,
        voids: voids[0] ?? { count: 0, value: 0 },
        refunds: refunds[0] ? { count: refunds[0].count, amount: refunds[0].amount } : { count: 0, amount: 0 },
        discounts: cur.discounts,
        unconfirmedMpesa: unconfirmed ? { count: unconfirmed.count, amount: unconfirmed.amount, reused: unconfirmed.reused } : { count: 0, amount: 0, reused: 0 },
      },
    };
  },
);

export default m;
