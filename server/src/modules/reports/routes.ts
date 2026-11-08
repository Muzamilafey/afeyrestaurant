import { z } from 'zod';
import { Types } from 'mongoose';
import { createModule } from '../../http/route';
import { Order, Payment, Refund, KitchenTicket, StockLedger, StockBalance, Ingredient, Expense, CashSession, GoodsReceivedNote, PaymentAttempt, MpesaC2BTransaction, Tenant, Table, AuditLog, Supplier } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import type { TenantContext } from '../../http/context';
import { forbidden, badRequest } from '../../lib/errors';
import { toCsv } from '../../services/attendance';
import { lowStockItems } from '../inventory/routes';

const m = createModule('/reports', 'Reports');

/** An order's outlet (restaurant or bar POS); older orders without one count by type. */
const OUTLET = { $ifNull: ['$outlet', { $cond: [{ $eq: ['$type', 'bar_counter'] }, 'bar', 'restaurant'] }] };

const zFilter = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: z.string().optional(), // a branch id or "all"
  cashierId: z.string().optional(), waiterId: z.string().optional(), categoryId: z.string().optional(), method: z.string().optional(), outlet: z.enum(['restaurant', 'bar']).optional(), format: z.enum(['json', 'csv']).optional(),
});
type Filter = z.infer<typeof zFilter>;

/** Resolve the branch scope for a report, enforcing branch permissions. */
function scope(ctx: TenantContext, q: Filter) {
  let branchIds: Types.ObjectId[];
  if (!q.branchId) branchIds = ctx.branchId ? [ctx.branchId] : [];
  else if (q.branchId === 'all') {
    if (!ctx.allBranches) throw forbidden('Business-wide reports require access to all branches');
    branchIds = ctx.allowedBranchIds;
  } else {
    if (!ctx.allowedBranchIds.some((b) => String(b) === q.branchId)) throw forbidden('You are not assigned to this branch');
    branchIds = [new Types.ObjectId(q.branchId)];
  }
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(new Date(to).setHours(0, 0, 0, 0));
  if (to.getTime() - from.getTime() > 400 * 86400_000) throw badRequest('Maximum report range is 400 days');
  return { tenantId: ctx.tenantId, branchIds, from, to };
}
const oid = (s?: string) => (s && Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : undefined);

m.route({ method: 'get', path: '/sales', summary: 'Sales dashboard: revenue, trends, payment mix, top items, staff', auth: 'tenant', permission: P.REPORTS_SALES, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  const tz = (await Tenant.findById(ctx.tenantId).lean())?.settings?.timezone ?? 'Africa/Nairobi';
  const match: Record<string, unknown> = { tenantId: s.tenantId, branchId: { $in: s.branchIds }, status: 'paid', paidAt: { $gte: s.from, $lte: s.to } };
  if (oid(query.cashierId)) match.cashierId = oid(query.cashierId);
  if (oid(query.waiterId)) match.waiterId = oid(query.waiterId);
  // Orders from before outlets existed count as bar when they were bar-counter orders, otherwise restaurant.
  if (query.outlet) match.$expr = { $eq: [OUTLET, query.outlet] };
  const days = (s.to.getTime() - s.from.getTime()) / 86400_000;
  const [summary] = await Order.aggregate([{ $match: match }, { $group: { _id: null, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 }, discounts: { $sum: '$totals.discount' }, serviceCharge: { $sum: '$totals.serviceCharge' }, taxInclusive: { $sum: '$totals.taxInclusive' }, taxExclusive: { $sum: '$totals.taxExclusive' }, refunded: { $sum: '$totals.refunded' }, guests: { $sum: '$guests' } } }]);
  const [trend, byBranch, byCashier, byWaiter, byType, items, voids, byOutlet, tips] = await Promise.all([
    Order.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: days > 2 ? '%Y-%m-%d' : '%Y-%m-%d %H:00', date: '$paidAt', timezone: tz } }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: '$branchId', revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: '$cashierId', revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } }, { $project: { revenue: 1, orders: 1, name: { $first: '$u.name' } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: '$waiterId', name: { $first: '$waiterName' }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: '$type', revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: match }, { $unwind: '$items' }, { $match: { 'items.voided': { $ne: true }, ...(oid(query.categoryId) ? { 'items.categoryId': oid(query.categoryId) } : {}) } },
      { $group: { _id: { product: '$items.productId', category: '$items.categoryId' }, name: { $first: '$items.name' }, qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' }, comps: { $sum: { $cond: ['$items.complimentary', '$items.qty', 0] } } } },
      { $lookup: { from: 'categories', localField: '_id.category', foreignField: '_id', as: 'c' } }, { $project: { name: 1, qty: 1, revenue: 1, comps: 1, category: { $first: '$c.name' } } }, { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, updatedAt: { $gte: s.from, $lte: s.to } } }, { $unwind: '$items' }, { $match: { 'items.voided': true, 'items.voidReason': { $exists: true } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $multiply: ['$items.qty', '$items.unitPrice'] } } } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: OUTLET, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    // Tips are outside sales: from the payments, credited to the waiter of the order.
    Payment.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, receivedAt: { $gte: s.from, $lte: s.to }, tip: { $gt: 0 } } }, { $group: { _id: { user: '$tipFor.userId', method: '$method' }, name: { $first: '$tipFor.name' }, amount: { $sum: '$tip' }, count: { $sum: 1 } } }]),
  ]);
  const tipsByStaff = Object.values(tips.reduce((acc: Record<string, { userId: string; name: string; cash: number; mpesa: number; total: number; count: number }>, t) => {
    const k = String(t._id.user ?? 'none');
    acc[k] ??= { userId: k, name: t.name ?? '—', cash: 0, mpesa: 0, total: 0, count: 0 };
    acc[k][t._id.method === 'cash' ? 'cash' : 'mpesa'] += t.amount;
    acc[k].total += t.amount;
    acc[k].count += t.count;
    return acc;
  }, {})).sort((a, b) => b.total - a.total);
  const payMatch: Record<string, unknown> = { tenantId: s.tenantId, branchId: { $in: s.branchIds }, receivedAt: { $gte: s.from, $lte: s.to } };
  if (query.method) payMatch.method = query.method;
  const [payments, refunds] = await Promise.all([
    Payment.aggregate([{ $match: payMatch }, { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 }, manual: { $sum: { $cond: [{ $eq: ['$verification', 'manual'] }, 1, 0] } } } }]),
    Refund.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  const hourly = await Order.aggregate([{ $match: match }, { $group: { _id: { $hour: { date: '$paidAt', timezone: tz } }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const categories = Object.values(items.reduce((acc: Record<string, { category: string; revenue: number; qty: number }>, i) => {
    const k = i.category ?? 'Uncategorised';
    acc[k] ??= { category: k, revenue: 0, qty: 0 };
    acc[k].revenue += i.revenue;
    acc[k].qty += i.qty;
    return acc;
  }, {})).sort((a, b) => b.revenue - a.revenue);
  const rev = summary?.revenue ?? 0;
  return {
    range: { from: s.from, to: s.to },
    summary: { revenue: rev, orders: summary?.orders ?? 0, averageOrderValue: summary?.orders ? Math.round(rev / summary.orders) : 0, discounts: summary?.discounts ?? 0, serviceCharge: summary?.serviceCharge ?? 0, tax: (summary?.taxInclusive ?? 0) + (summary?.taxExclusive ?? 0), refunded: summary?.refunded ?? 0, netSales: rev - (summary?.taxExclusive ?? 0) - (summary?.taxInclusive ?? 0) - (summary?.serviceCharge ?? 0), guests: summary?.guests ?? 0, voids: voids[0] ?? { count: 0, value: 0 } },
    trend, hourly, byBranch, byCashier, byWaiter, byType, byOutlet: byOutlet.map((x) => ({ outlet: x._id as string, revenue: x.revenue, orders: x.orders })), tips: { total: tipsByStaff.reduce((a, t) => a + t.total, 0), byStaff: tipsByStaff }, topItems: items.slice(0, 20), allItems: items, categories, payments, refunds,
  };
});

m.route({ method: 'get', path: '/sales/export', summary: 'Export paid orders as CSV', auth: 'tenant', permission: P.REPORTS_SALES, query: zFilter, raw: true }, async ({ ctx, query, res }) => {
  const s = scope(ctx, query);
  const orders = await Order.find({ tenantId: s.tenantId, branchId: { $in: s.branchIds }, status: 'paid', paidAt: { $gte: s.from, $lte: s.to }, ...(query.outlet ? { $expr: { $eq: [OUTLET, query.outlet] } } : {}) }).sort({ paidAt: 1 }).limit(50000).lean();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sales-${s.from.toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(orders.map((o) => ({ receipt: o.receiptNumber, order: o.number, paidAt: o.paidAt, outlet: o.outlet ?? (o.type === 'bar_counter' ? 'bar' : 'restaurant'), type: o.type, table: o.tableNumber, waiter: o.waiterName, subtotal: (o.totals!.subtotal / 100).toFixed(2), discount: (o.totals!.discount / 100).toFixed(2), service: (o.totals!.serviceCharge / 100).toFixed(2), tax: ((o.totals!.taxInclusive + o.totals!.taxExclusive) / 100).toFixed(2), total: (o.totals!.total / 100).toFixed(2), refunded: (o.totals!.refunded / 100).toFixed(2), source: o.source }))));
});

m.route({ method: 'get', path: '/reconciliation', summary: 'Payment reconciliation: cash, M-Pesa, card, split', auth: 'tenant', permission: [P.REPORTS_FINANCIAL, P.ACCOUNTING_VIEW], query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  const base = { tenantId: s.tenantId, branchId: { $in: s.branchIds } };
  const [byMethod, attempts, c2b, sessions, split, offline] = await Promise.all([
    Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: { method: '$method', verification: '$verification' }, amount: { $sum: '$amount' }, refunded: { $sum: '$refundedAmount' }, count: { $sum: 1 } } }]),
    PaymentAttempt.aggregate([{ $match: { ...base, method: 'mpesa', createdAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    MpesaC2BTransaction.aggregate([{ $match: { tenantId: s.tenantId, createdAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    CashSession.find({ ...base, openedAt: { $gte: s.from, $lte: s.to } }).sort({ openedAt: -1 }).lean(),
    Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$orderId', methods: { $addToSet: '$method' }, amount: { $sum: '$amount' } } }, { $match: { 'methods.1': { $exists: true } } }, { $count: 'orders' }]),
    Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: s.from, $lte: s.to }, verification: 'offline_cash' } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    ]);
  const mpesaIssues = await PaymentAttempt.find({ ...base, method: 'mpesa', createdAt: { $gte: s.from, $lte: s.to }, $or: [{ status: 'error' }, { error: { $exists: true, $ne: null } }] }, { callbackTokenHash: 0 }).limit(100).lean();
  return { byMethod, mpesaAttempts: attempts, c2b, cashSessions: sessions, splitPaymentOrders: split[0]?.orders ?? 0, offlineCash: offline[0] ?? { amount: 0, count: 0 }, mpesaIssues };
});

m.route({ method: 'get', path: '/kitchen', summary: 'Kitchen/bar preparation times and delays', auth: 'tenant', permission: P.REPORTS_SALES, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  return KitchenTicket.aggregate([
    { $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to }, readyAt: { $exists: true } } },
    { $project: { station: 1, prep: { $divide: [{ $subtract: ['$readyAt', '$createdAt'] }, 60000] } } },
    { $group: { _id: '$station', tickets: { $sum: 1 }, avgMinutes: { $avg: '$prep' }, maxMinutes: { $max: '$prep' }, over15: { $sum: { $cond: [{ $gt: ['$prep', 15] }, 1, 0] } } } },
  ]);
});

m.route({ method: 'get', path: '/tables', summary: 'Table occupancy and turnover', auth: 'tenant', permission: P.REPORTS_SALES, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  const rows = await Order.aggregate([
    { $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, status: 'paid', type: 'dine_in', paidAt: { $gte: s.from, $lte: s.to } } },
    { $group: { _id: '$tableId', table: { $first: '$tableNumber' }, turns: { $sum: 1 }, revenue: { $sum: '$totals.total' }, guests: { $sum: '$guests' }, avgMinutes: { $avg: { $divide: [{ $subtract: ['$paidAt', '$createdAt'] }, 60000] } } } },
    { $sort: { table: 1 } },
  ]);
  const tables = await Table.countDocuments({ tenantId: s.tenantId, branchId: { $in: s.branchIds }, active: true });
  return { tables, rows };
});

m.route({ method: 'get', path: '/inventory', summary: 'Stock valuation, consumption, wastage, COGS and low stock', auth: 'tenant', permission: P.REPORTS_INVENTORY, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  const [valuation, movements, ingredients] = await Promise.all([
    StockBalance.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds } } }, { $group: { _id: '$ingredientId', qty: { $sum: '$qty' }, value: { $sum: '$value' } } }]),
    StockLedger.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: { ingredient: '$ingredientId', type: '$type' }, qty: { $sum: '$qty' }, cost: { $sum: '$totalCost' } } }]),
    Ingredient.find({ tenantId: s.tenantId }, { name: 1, baseUnit: 1, isBarItem: 1, minLevel: 1 }).lean(),
  ]);
  const name = (id: unknown) => ingredients.find((i) => String(i._id) === String(id));
  const typeTotal = (t: string[]) => movements.filter((x) => t.includes(x._id.type)).reduce((a, x) => a - x.cost, 0);
  const consumption = movements.filter((x) => ['sale', 'complimentary'].includes(x._id.type)).map((x) => ({ ingredient: name(x._id.ingredient)?.name, unit: name(x._id.ingredient)?.baseUnit, type: x._id.type, qty: -x.qty, cost: -x.cost })).sort((a, b) => b.cost - a.cost);
  const wastage = movements.filter((x) => ['wastage', 'breakage', 'spoilage'].includes(x._id.type)).map((x) => ({ ingredient: name(x._id.ingredient)?.name, unit: name(x._id.ingredient)?.baseUnit, type: x._id.type, qty: -x.qty, cost: -x.cost }));
  // Bar variance: theoretical usage (sales) vs physical count variances for bar items.
  const barVariance = ingredients.filter((i) => i.isBarItem).map((i) => {
    const sold = movements.filter((x) => String(x._id.ingredient) === String(i._id) && ['sale', 'complimentary'].includes(x._id.type)).reduce((a, x) => a - x.qty, 0);
    const variance = movements.filter((x) => String(x._id.ingredient) === String(i._id) && x._id.type === 'count_variance').reduce((a, x) => a + x.qty, 0);
    return { ingredient: i.name, unit: i.baseUnit, theoreticalUsage: sold, countVariance: variance, variancePct: sold ? Math.round((variance / sold) * 1000) / 10 : null };
  });
  const lowStock = (await Promise.all(s.branchIds.map((b) => lowStockItems(s.tenantId, b)))).flat();
  return {
    valuation: { total: valuation.reduce((a, v) => a + v.value, 0), items: valuation.map((v) => ({ ingredient: name(v._id)?.name, unit: name(v._id)?.baseUnit, qty: v.qty, value: v.value })).sort((a, b) => b.value - a.value) },
    cogs: typeTotal(['sale']), complimentaryCost: typeTotal(['complimentary']), wastageCost: typeTotal(['wastage', 'breakage', 'spoilage']),
    consumption, wastage, barVariance, lowStock,
  };
});

m.route({ method: 'get', path: '/profit-loss', summary: 'Branch profit & loss: net sales, COGS, gross margin, expenses', auth: 'tenant', permission: P.REPORTS_FINANCIAL, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  const [sales] = await Order.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, status: 'paid', paidAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: null, gross: { $sum: '$totals.total' }, taxIncl: { $sum: '$totals.taxInclusive' }, taxExcl: { $sum: '$totals.taxExclusive' }, service: { $sum: '$totals.serviceCharge' }, discount: { $sum: '$totals.discount' }, delivery: { $sum: '$totals.deliveryFee' } } }]);
  const [refunds] = await Refund.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]);
  const cogsRows = await StockLedger.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to }, type: { $in: ['sale', 'sale_reversal', 'complimentary', 'wastage', 'breakage', 'spoilage', 'count_variance'] } } }, { $group: { _id: '$type', cost: { $sum: '$totalCost' } } }]);
  const expenses = await Expense.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, date: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$category', amount: { $sum: '$amount' } } }, { $sort: { amount: -1 } }]);
  const purchases = await GoodsReceivedNote.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, receivedAt: { $gte: s.from, $lte: s.to } } }, { $group: { _id: '$supplierId', amount: { $sum: '$total' }, count: { $sum: 1 } } }]);
  const suppliers = await Supplier.find({ tenantId: s.tenantId, _id: { $in: purchases.map((p) => p._id) } }, { name: 1 }).lean();
  const c = (t: string) => -(cogsRows.find((r) => r._id === t)?.cost ?? 0);
  const tax = (sales?.taxIncl ?? 0) + (sales?.taxExcl ?? 0);
  const netSales = (sales?.gross ?? 0) - tax - (refunds?.amount ?? 0);
  const cogs = c('sale') + c('sale_reversal') + c('complimentary');
  const shrinkage = c('wastage') + c('breakage') + c('spoilage') + c('count_variance');
  const grossProfit = netSales - cogs - shrinkage;
  const totalExpenses = expenses.reduce((a, e) => a + e.amount, 0);
  return {
    // Revenue (accrual) is reported separately from cash collected, settlements and expenses.
    revenue: { grossSales: sales?.gross ?? 0, discounts: sales?.discount ?? 0, serviceCharge: sales?.service ?? 0, deliveryFees: sales?.delivery ?? 0, tax, refunds: refunds?.amount ?? 0, netSales },
    costOfSales: { cogs: Math.round(cogs), shrinkage: Math.round(shrinkage), foodCostPct: netSales ? Math.round((cogs / netSales) * 1000) / 10 : null },
    grossProfit: Math.round(grossProfit), grossMarginPct: netSales ? Math.round((grossProfit / netSales) * 1000) / 10 : null,
    expenses: { total: totalExpenses, byCategory: expenses },
    operatingProfit: Math.round(grossProfit - totalExpenses),
    purchases: purchases.map((p) => ({ supplier: suppliers.find((x) => String(x._id) === String(p._id))?.name, amount: p.amount, count: p.count })),
    note: 'Purchases are not expenses: inventory is expensed through COGS when consumed.',
  };
});

m.route({ method: 'get', path: '/tax', summary: 'Sales tax summary by tax code', auth: 'tenant', permission: P.REPORTS_FINANCIAL, query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  return Order.aggregate([{ $match: { tenantId: s.tenantId, branchId: { $in: s.branchIds }, status: 'paid', paidAt: { $gte: s.from, $lte: s.to } } }, { $unwind: '$taxBreakdown' }, { $group: { _id: { code: '$taxBreakdown.code', rate: '$taxBreakdown.rateBps', inclusive: '$taxBreakdown.inclusive' }, amount: { $sum: '$taxBreakdown.amount' }, orders: { $sum: 1 } } }]);
});

m.route({ method: 'get', path: '/exceptions', summary: 'Discounts, voids, refunds, overrides and manual confirmations (audit)', auth: 'tenant', permission: [P.REPORTS_FINANCIAL, P.AUDIT_VIEW], query: zFilter }, async ({ ctx, query }) => {
  const s = scope(ctx, query);
  return AuditLog.find({ tenantId: s.tenantId, branchId: { $in: s.branchIds }, createdAt: { $gte: s.from, $lte: s.to }, action: { $in: ['order.discount', 'order.void_item', 'order.void', 'order.complimentary', 'payment.refund', 'payment.mpesa_manual', 'inventory.override_sale', 'receipt.reprint', 'inventory.wastage', 'inventory.adjustment', 'inventory.breakage'] } }).sort({ createdAt: -1 }).limit(500).lean();
});

export default m;
