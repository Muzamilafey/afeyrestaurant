import { Types } from 'mongoose';
import { Branch, CashSession, Order, Payment, Refund, Tenant } from '../models';
import { sessionTotals } from '../modules/cash/routes';
import { dayRange } from '../lib/time';
import { amount, type ReceiptDoc, type ReceiptLine } from './receipt';

/** An order's outlet (restaurant or bar POS); older orders without one count by type. */
const OUTLET = { $ifNull: ['$outlet', { $cond: [{ $eq: ['$type', 'bar_counter'] }, 'bar', 'restaurant'] }] };

export interface ZReport {
  date: string; timezone: string; from: Date; to: Date; generatedAt: Date;
  business: string; branches: string[];
  sales: { gross: number; net: number; orders: number; guests: number; average: number; discounts: number; serviceCharge: number; tax: number; refunds: number; refundCount: number; voids: { count: number; value: number }; comps: { count: number; value: number } };
  payments: Array<{ label: string; method: string; amount: number; count: number }>;
  tips: { cash: number; mpesa: number; total: number; byStaff: Array<{ name: string; amount: number }> };
  byOutlet: Array<{ outlet: string; revenue: number; orders: number }>;
  byType: Array<{ type: string; revenue: number; orders: number }>;
  byWaiter: Array<{ name: string; revenue: number; orders: number }>;
  topItems: Array<{ name: string; qty: number; revenue: number }>;
  drawers: Array<{ who: string; shared: boolean; status: string; openedAt: Date; closedAt?: Date | null; float: number; cashSales: number; cashTips: number; expected: number; counted: number | null; variance: number | null }>;
  receipts: { first?: string; last?: string };
  attention: { openOrders: number; openValue: number; unconfirmedMpesa: number; manualMpesa: number };
}

/** End-of-day figures for one business day, for one branch or all of them. */
export async function buildZReport(tenantId: Types.ObjectId, branchIds: Types.ObjectId[], date: string): Promise<ZReport> {
  const tenant = await Tenant.findById(tenantId).lean();
  const tz = tenant?.settings?.timezone ?? 'Africa/Nairobi';
  const { start, end } = dayRange(date, tz);
  const base = { tenantId, branchId: { $in: branchIds } };
  const paid = { ...base, status: 'paid', paidAt: { $gte: start, $lt: end } };
  const label = (method: string, verification?: string) =>
    method === 'mpesa' ? (verification === 'manual' ? 'M-Pesa (manual)' : verification === 'offline_mpesa' ? 'M-Pesa (offline code)' : 'M-Pesa') : ({ cash: 'Cash', card: 'Card', qr: 'QR', account: 'On account', voucher: 'Voucher' } as Record<string, string>)[method] ?? method;

  const [branches, summary, pays, tips, refunds, voids, comps, byOutlet, byType, byWaiter, topItems, receipts, sessions, open] = await Promise.all([
    Branch.find({ tenantId, _id: { $in: branchIds } }).select('name').lean(),
    Order.aggregate([{ $match: paid }, { $group: { _id: null, gross: { $sum: '$totals.total' }, orders: { $sum: 1 }, guests: { $sum: '$guests' }, discounts: { $sum: '$totals.discount' }, service: { $sum: '$totals.serviceCharge' }, taxIn: { $sum: '$totals.taxInclusive' }, taxEx: { $sum: '$totals.taxExclusive' } } }]),
    Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: start, $lt: end } } }, { $group: { _id: { method: '$method', verification: '$verification' }, amount: { $sum: '$amount' }, count: { $sum: 1 }, provisional: { $sum: { $cond: [{ $eq: ['$status', 'provisional'] }, 1, 0] } } } }]),
    Payment.aggregate([{ $match: { ...base, receivedAt: { $gte: start, $lt: end }, tip: { $gt: 0 } } }, { $group: { _id: { name: '$tipFor.name', method: '$method' }, amount: { $sum: '$tip' } } }]),
    Refund.aggregate([{ $match: { ...base, createdAt: { $gte: start, $lt: end } } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { ...base, updatedAt: { $gte: start, $lt: end } } }, { $unwind: '$items' }, { $match: { 'items.voided': true, 'items.voidReason': { $exists: true } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $multiply: ['$items.qty', '$items.unitPrice'] } } } }]),
    Order.aggregate([{ $match: paid }, { $unwind: '$items' }, { $match: { 'items.complimentary': true, 'items.voided': { $ne: true } } }, { $group: { _id: null, count: { $sum: '$items.qty' }, value: { $sum: { $multiply: ['$items.qty', '$items.unitPrice'] } } } }]),
    Order.aggregate([{ $match: paid }, { $group: { _id: OUTLET, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: paid }, { $group: { _id: '$type', revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: paid }, { $group: { _id: '$waiterId', name: { $first: '$waiterName' }, revenue: { $sum: '$totals.total' }, orders: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: paid }, { $unwind: '$items' }, { $match: { 'items.voided': { $ne: true } } }, { $group: { _id: '$items.productId', name: { $first: '$items.name' }, qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.lineTotal' } } }, { $sort: { revenue: -1 } }, { $limit: 10 }]),
    Order.find({ ...paid, receiptNumber: { $type: 'string' } }).sort({ paidAt: 1 }).select('receiptNumber').lean(),
    CashSession.find({ ...base, openedAt: { $lt: end }, $or: [{ closedAt: null }, { closedAt: { $gte: start } }] }).sort({ openedAt: 1 }).lean(),
    Order.aggregate([{ $match: { ...base, status: { $in: ['open', 'held'] }, createdAt: { $lt: end } } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $subtract: ['$totals.total', '$totals.paid'] } } } }]),
  ]);

  const s = summary[0] ?? { gross: 0, orders: 0, guests: 0, discounts: 0, service: 0, taxIn: 0, taxEx: 0 };
  const tax = (s.taxIn ?? 0) + (s.taxEx ?? 0);
  const payments = Object.values(pays.reduce((acc: Record<string, { label: string; method: string; amount: number; count: number }>, p) => {
    const l = label(p._id.method, p._id.verification);
    acc[l] ??= { label: l, method: p._id.method, amount: 0, count: 0 };
    acc[l].amount += p.amount;
    acc[l].count += p.count;
    return acc;
  }, {})).sort((a, b) => b.amount - a.amount);
  const tipStaff = new Map<string, number>();
  let cashTips = 0;
  let mpesaTips = 0;
  for (const t of tips) {
    if (t._id.method === 'cash') cashTips += t.amount;
    else mpesaTips += t.amount;
    tipStaff.set(t._id.name ?? '—', (tipStaff.get(t._id.name ?? '—') ?? 0) + t.amount);
  }
  const drawers = await Promise.all(sessions.map(async (cs) => {
    const live = cs.status === 'open' ? await sessionTotals(tenantId, cs) : null;
    const totals = live?.totals ?? cs.totals;
    return {
      who: cs.shared ? `Shared drawer (opened by ${cs.userName ?? '—'})` : cs.userName ?? '—', shared: !!cs.shared, status: cs.status, openedAt: cs.openedAt, closedAt: cs.closedAt,
      float: cs.openingFloat, cashSales: totals?.cashSales ?? 0, cashTips: totals?.cashTips ?? 0, expected: live?.expected ?? cs.expectedCash ?? 0,
      counted: cs.countedCash ?? null, variance: cs.variance ?? null,
    };
  }));
  return {
    date, timezone: tz, from: start, to: end, generatedAt: new Date(), business: tenant?.name ?? '', branches: branches.map((b) => b.name),
    sales: {
      gross: s.gross, net: s.gross - tax - (s.service ?? 0), orders: s.orders, guests: s.guests ?? 0, average: s.orders ? Math.round(s.gross / s.orders) : 0,
      discounts: s.discounts ?? 0, serviceCharge: s.service ?? 0, tax, refunds: refunds[0]?.amount ?? 0, refundCount: refunds[0]?.count ?? 0,
      voids: { count: voids[0]?.count ?? 0, value: voids[0]?.value ?? 0 }, comps: { count: comps[0]?.count ?? 0, value: comps[0]?.value ?? 0 },
    },
    payments,
    tips: { cash: cashTips, mpesa: mpesaTips, total: cashTips + mpesaTips, byStaff: [...tipStaff].map(([name, a]) => ({ name, amount: a })).sort((a, b) => b.amount - a.amount) },
    byOutlet: byOutlet.map((x) => ({ outlet: x._id as string, revenue: x.revenue, orders: x.orders })),
    byType: byType.map((x) => ({ type: x._id as string, revenue: x.revenue, orders: x.orders })),
    byWaiter: byWaiter.map((x) => ({ name: x.name ?? '—', revenue: x.revenue, orders: x.orders })),
    topItems: topItems.map((x) => ({ name: x.name, qty: x.qty, revenue: x.revenue })),
    drawers,
    receipts: { first: receipts[0]?.receiptNumber ?? undefined, last: receipts[receipts.length - 1]?.receiptNumber ?? undefined },
    attention: {
      openOrders: open[0]?.count ?? 0, openValue: open[0]?.value ?? 0,
      unconfirmedMpesa: pays.reduce((a, p) => a + (p._id.method === 'mpesa' ? p.provisional : 0), 0),
      manualMpesa: pays.filter((p) => p._id.method === 'mpesa' && p._id.verification === 'manual').reduce((a, p) => a + p.count, 0),
    },
  };
}

const typeLabel = (t: string) => ({ dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', bar_counter: 'Bar counter', room_service: 'Room service', online: 'Online' } as Record<string, string>)[t] ?? t;

/** The Z report as an 80 mm slip (same renderer as receipts: browser print, thermal printers, text). */
export function zReportDoc(z: ZReport, closed?: { closedAt: Date; closedByName?: string | null } | null): ReceiptDoc {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: z.timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  const L: ReceiptLine[] = [];
  const row = (l: string, r: string, o: { bold?: boolean; big?: boolean; muted?: boolean } = {}) => L.push({ k: 'row', l, r, ...o });
  L.push({ k: 'title', t: z.business || 'Chili POS' });
  L.push({ k: 'center', t: z.branches.join(', ') || 'All branches', muted: true });
  L.push({ k: 'banner', t: closed ? 'END OF DAY - Z REPORT' : 'X REPORT (DAY NOT CLOSED)' });
  L.push({ k: 'center', t: `Business day ${z.date}`, bold: true });
  L.push({ k: 'center', t: closed ? `Closed ${fmt(closed.closedAt)} by ${closed.closedByName ?? '-'}` : `Printed ${fmt(z.generatedAt)}`, muted: true });
  L.push({ k: 'rule', heavy: true });
  row('Gross sales', amount(z.sales.gross), { bold: true, big: true });
  row('Orders', String(z.sales.orders));
  row('Average order', amount(z.sales.average));
  if (z.sales.guests) row('Guests', String(z.sales.guests));
  row('Tax', amount(z.sales.tax));
  if (z.sales.serviceCharge) row('Service charge', amount(z.sales.serviceCharge));
  row('Net sales', amount(z.sales.net), { bold: true });
  L.push({ k: 'rule' });
  row('Discounts', amount(z.sales.discounts));
  row(`Voids (${z.sales.voids.count})`, amount(z.sales.voids.value));
  if (z.sales.comps.count) row(`Complimentary (${z.sales.comps.count})`, amount(z.sales.comps.value));
  row(`Refunds (${z.sales.refundCount})`, amount(z.sales.refunds));
  L.push({ k: 'rule' });
  L.push({ k: 'center', t: 'PAYMENTS', bold: true });
  for (const p of z.payments) row(`${p.label} (${p.count})`, amount(p.amount));
  if (!z.payments.length) row('No payments', '');
  if (z.tips.total) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'TIPS (not in sales)', bold: true });
    if (z.tips.cash) row('Cash tips', amount(z.tips.cash));
    if (z.tips.mpesa) row('M-Pesa tips', amount(z.tips.mpesa));
    for (const t of z.tips.byStaff) row(`  ${t.name}`, amount(t.amount), { muted: true });
  }
  if (z.byOutlet.length > 1 || z.byType.length > 1) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'SALES BY', bold: true });
    for (const o of z.byOutlet) row(o.outlet === 'bar' ? 'Bar POS' : 'Restaurant POS', amount(o.revenue));
    for (const t of z.byType) row(`  ${typeLabel(t.type)} (${t.orders})`, amount(t.revenue), { muted: true });
  }
  if (z.byWaiter.length) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'STAFF', bold: true });
    for (const w of z.byWaiter) row(`${w.name} (${w.orders})`, amount(w.revenue));
  }
  if (z.drawers.length) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'CASH DRAWERS', bold: true });
    for (const d of z.drawers) {
      row(d.who, d.status === 'open' ? 'OPEN' : 'closed', { bold: true });
      row('  Float', amount(d.float), { muted: true });
      row('  Cash sales', amount(d.cashSales), { muted: true });
      if (d.cashTips) row('  Cash tips', amount(d.cashTips), { muted: true });
      row('  Expected', amount(d.expected));
      if (d.counted !== null) row('  Counted', amount(d.counted));
      if (d.variance !== null) row('  Over / short', `${d.variance > 0 ? '+' : ''}${amount(d.variance)}`, { bold: d.variance !== 0 });
    }
  }
  if (z.topItems.length) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'TOP ITEMS', bold: true });
    for (const i of z.topItems) row(`${i.qty} x ${i.name}`, amount(i.revenue));
  }
  const warn: string[] = [];
  if (z.attention.openOrders) warn.push(`${z.attention.openOrders} order(s) still open: ${amount(z.attention.openValue)} unpaid`);
  if (z.attention.unconfirmedMpesa) warn.push(`${z.attention.unconfirmedMpesa} offline M-Pesa code(s) not yet confirmed`);
  if (z.attention.manualMpesa) warn.push(`${z.attention.manualMpesa} manual M-Pesa payment(s): check the statement`);
  if (z.drawers.some((d) => d.status === 'open')) warn.push('A cash drawer is still open');
  if (warn.length) {
    L.push({ k: 'rule' });
    L.push({ k: 'center', t: 'CHECK', bold: true });
    for (const w of warn) L.push({ k: 'center', t: w });
  }
  L.push({ k: 'rule', heavy: true });
  if (z.receipts.first) L.push({ k: 'center', t: `Receipts ${z.receipts.first} - ${z.receipts.last}`, muted: true });
  L.push({ k: 'space' });
  L.push({ k: 'center', t: 'Manager signature: ____________', muted: true });
  return { kind: 'report', copy: 'original', lines: L };
}
