import { Types } from 'mongoose';
import { Employee, Order, Payment } from '../models';
import { attendanceReport } from './attendance';

export interface PayrollRow {
  employeeId: string | null; employeeNo: string; name: string; jobTitle: string; linked: boolean;
  days: number; hours: number; overtimeHours: number; hourlyRate: number; basicPay: number; overtimePay: number;
  orders: number; netSales: number; commissionPct: number; commission: number; tipsCash: number; tipsMpesa: number; tips: number;
  grossPay: number; totalWithTips: number;
}

/**
 * Pay for a period, per employee: hours from attendance (regular + overtime), commission on the net sales (excluding
 * tax and service charge) of the orders they served, and their tips. Gross figures for the payroll system —
 * statutory deductions (PAYE, NSSF, SHIF, housing levy) are not calculated here.
 */
export async function payroll(tenantId: Types.ObjectId, branchId: Types.ObjectId, from: Date, to: Date, overtimeMultiplier = 1.5) {
  const [employees, attendance, sales, tips] = await Promise.all([
    Employee.find({ tenantId, branchId }).lean(),
    attendanceReport(tenantId, branchId, from, to),
    Order.aggregate([
      { $match: { tenantId, branchId, status: 'paid', paidAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$waiterId', name: { $first: '$waiterName' }, orders: { $sum: 1 }, net: { $sum: { $subtract: ['$totals.total', { $add: [{ $ifNull: ['$totals.taxInclusive', 0] }, { $ifNull: ['$totals.taxExclusive', 0] }, { $ifNull: ['$totals.serviceCharge', 0] }] }] } } } },
    ]),
    Payment.aggregate([{ $match: { tenantId, branchId, receivedAt: { $gte: from, $lte: to }, tip: { $gt: 0 } } }, { $group: { _id: { user: '$tipFor.userId', method: '$method' }, name: { $first: '$tipFor.name' }, amount: { $sum: '$tip' } } }]),
  ]);
  const work = new Map<string, { days: number; worked: number; overtime: number }>();
  for (const r of attendance) {
    const w = work.get(r.employeeId) ?? { days: 0, worked: 0, overtime: 0 };
    w.days += r.workedMinutes > 0 ? 1 : 0;
    w.worked += r.workedMinutes;
    w.overtime += r.overtimeMinutes;
    work.set(r.employeeId, w);
  }
  const salesBy = new Map(sales.map((s) => [String(s._id), s]));
  const tipsBy = new Map<string, { cash: number; mpesa: number; name?: string }>();
  for (const t of tips) {
    const k = String(t._id.user);
    const v = tipsBy.get(k) ?? { cash: 0, mpesa: 0, name: t.name };
    if (t._id.method === 'cash') v.cash += t.amount; else v.mpesa += t.amount;
    tipsBy.set(k, v);
  }
  const row = (base: { employeeId: string | null; employeeNo: string; name: string; jobTitle: string; linked: boolean; hourlyRate: number; commissionBps: number }, userKey: string | null): PayrollRow => {
    const w = base.employeeId ? work.get(base.employeeId) : undefined;
    const regularMin = Math.max(0, (w?.worked ?? 0) - (w?.overtime ?? 0));
    const basicPay = Math.round((regularMin / 60) * base.hourlyRate);
    const overtimePay = Math.round(((w?.overtime ?? 0) / 60) * base.hourlyRate * overtimeMultiplier);
    const s = userKey ? salesBy.get(userKey) : undefined;
    const netSales = Math.max(0, s?.net ?? 0);
    const commission = Math.round((netSales * base.commissionBps) / 10000);
    const t = userKey ? tipsBy.get(userKey) : undefined;
    const tipsTotal = (t?.cash ?? 0) + (t?.mpesa ?? 0);
    const grossPay = basicPay + overtimePay + commission;
    return {
      ...base, days: w?.days ?? 0, hours: Math.round(((w?.worked ?? 0) / 60) * 100) / 100, overtimeHours: Math.round(((w?.overtime ?? 0) / 60) * 100) / 100,
      basicPay, overtimePay, orders: s?.orders ?? 0, netSales, commissionPct: base.commissionBps / 100, commission,
      tipsCash: t?.cash ?? 0, tipsMpesa: t?.mpesa ?? 0, tips: tipsTotal, grossPay, totalWithTips: grossPay + tipsTotal,
    };
  };
  const rows: PayrollRow[] = employees.map((e) => row({ employeeId: String(e._id), employeeNo: e.employeeNo, name: e.name, jobTitle: e.jobTitle ?? '', linked: !!e.userId, hourlyRate: e.hourlyRate ?? 0, commissionBps: e.commissionBps ?? 0 }, e.userId ? String(e.userId) : null));
  // People who sold or got tips without an employee record (link them under Staff → Employees to pay commission).
  const linkedUsers = new Set(employees.filter((e) => e.userId).map((e) => String(e.userId)));
  for (const k of new Set([...salesBy.keys(), ...tipsBy.keys()])) {
    if (k === 'null' || k === 'undefined' || linkedUsers.has(k)) continue;
    rows.push(row({ employeeId: null, employeeNo: '—', name: salesBy.get(k)?.name ?? tipsBy.get(k)?.name ?? 'Unknown', jobTitle: '', linked: false, hourlyRate: 0, commissionBps: 0 }, k));
  }
  rows.sort((a, b) => b.totalWithTips - a.totalWithTips || a.name.localeCompare(b.name));
  const sum = (k: keyof PayrollRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  return { from, to, overtimeMultiplier, rows, totals: { basicPay: sum('basicPay'), overtimePay: sum('overtimePay'), commission: sum('commission'), tips: sum('tips'), grossPay: sum('grossPay'), totalWithTips: sum('totalWithTips') } };
}
