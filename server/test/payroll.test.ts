import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { AttendanceEvent, Branch, Employee, Product, User } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let manager: Session;
let empId = '';

describe('payroll & commissions', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [cashier, manager] = await Promise.all([login('cashier@chili.demo'), login('manager@chili.demo')]);
    const user = await User.findOne({ tenantId: seed.tenantId, email: 'cashier@chili.demo' }).lean();
    // KSh 200/hour, 5% commission; on the clock 09:00–17:00 yesterday.
    const emp = await Employee.findOneAndUpdate({ tenantId: seed.tenantId, userId: user!._id }, { $set: { hourlyRate: 20000, commissionBps: 500 } }, { new: true });
    empId = String(emp!._id);
    const day = new Date(Date.now() - 86400_000);
    const at = (h: number) => { const d = new Date(day); d.setUTCHours(h - 3, 0, 0, 0); return d; }; // Nairobi = UTC+3
    await AttendanceEvent.insertMany([
      { tenantId: seed.tenantId, branchId: seed.mainBranchId, employeeId: emp!._id, type: 'clock_in', at: at(9), source: 'manual', dedupeKey: `t-in-${empId}` },
      { tenantId: seed.tenantId, branchId: seed.mainBranchId, employeeId: emp!._id, type: 'clock_out', at: at(17), source: 'manual', dedupeKey: `t-out-${empId}` },
    ]);
    await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 0 }));
  });
  afterAll(teardownDb);

  it('adds hours, commission on net sales served and tips; exports CSV', async () => {
    const coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    const o = (await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 10 }] }))).body.data;
    await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ method: 'cash', amount: o.totals.total, tip: 10000, tendered: o.totals.total + 10000, idempotencyKey: uuid() }));
    const net = o.totals.total - o.totals.taxInclusive - o.totals.taxExclusive - o.totals.serviceCharge;

    const from = new Date(Date.now() - 3 * 86400_000).toISOString();
    const to = new Date().toISOString();
    const r = await manager.as(api().get(`/api/v1/staff/payroll?from=${from}&to=${to}`));
    expect(r.status).toBe(200);
    const row = r.body.data.rows.find((x: { employeeId: string }) => x.employeeId === empId);
    // 8 hours on the clock minus the shift's unpaid break (from attendance).
    expect(row.hours).toBeGreaterThan(6);
    expect(row.basicPay).toBe(Math.round((row.hours - row.overtimeHours) * 20000));
    expect(row).toMatchObject({ orders: 1, netSales: net, commissionPct: 5, commission: Math.round(net * 0.05), tips: 10000, tipsCash: 10000 });
    expect(row.grossPay).toBe(row.basicPay + row.overtimePay + row.commission);
    expect(row.totalWithTips).toBe(row.grossPay + 10000);

    const csv = await manager.as(api().get(`/api/v1/staff/payroll?from=${from}&to=${to}&format=csv`));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('commission');
    expect((await cashier.as(api().get(`/api/v1/staff/payroll?from=${from}&to=${to}`))).status).toBe(403);
  });
});
