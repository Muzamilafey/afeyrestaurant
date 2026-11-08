import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, Order, Payment, Product } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let manager: Session;
let coke = '';
const newOrder = async () => (await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 2 }] }))).body.data as { _id: string; totals: { total: number } };

describe('tips', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [cashier, manager] = await Promise.all([login('cashier@chili.demo'), login('manager@chili.demo')]);
    coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 100000 }));
  });
  afterAll(teardownDb);

  it('cash tip: outside the bill, in the drawer, credited to the waiter', async () => {
    const o = await newOrder();
    const short = await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ method: 'cash', amount: o.totals.total, tip: 5000, tendered: o.totals.total, idempotencyKey: uuid() }));
    expect(short.status).toBe(400);
    const r = await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ method: 'cash', amount: o.totals.total, tip: 5000, tendered: o.totals.total + 10000, idempotencyKey: uuid() }));
    expect(r.status).toBe(201);
    expect(r.body.data.order.status).toBe('paid');
    expect(r.body.data.payment).toMatchObject({ amount: o.totals.total, tip: 5000, change: 5000 });
    const saved = await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean();
    expect(saved!.totals).toMatchObject({ paid: o.totals.total, tips: 5000 });
    const drawer = await cashier.as(api().get('/api/v1/cash/session'));
    expect(drawer.body.data.totals).toMatchObject({ cashSales: o.totals.total, cashTips: 5000 });
    expect(drawer.body.data.expected).toBe(100000 + o.totals.total + 5000);
    const receipt = await cashier.as(api().get(`/api/v1/orders/${o._id}/receipt`));
    expect(receipt.body.data.text).toContain('Tip');
  });

  it('M-Pesa prompt asks for bill + tip; the tip is recorded apart and shows in the report', async () => {
    const o = await newOrder();
    const a = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, tip: 10000, idempotencyKey: uuid() }));
    expect(a.status).toBe(200);
    expect(a.body.data.amount).toBe(o.totals.total + 10000);
    await cashier.as(api().post(`/api/v1/mpesa/simulate/${a.body.data._id}`).send({ resultCode: 0 }));
    const p = await Payment.findOne({ tenantId: seed.tenantId, orderId: o._id }).lean();
    expect(p).toMatchObject({ method: 'mpesa', amount: o.totals.total, tip: 10000 });
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean())!.status).toBe('paid');
    const rep = await manager.as(api().get('/api/v1/reports/sales'));
    expect(rep.body.data.tips.total).toBe(15000);
    expect(rep.body.data.tips.byStaff[0]).toMatchObject({ cash: 5000, mpesa: 10000, total: 15000 });
    // Sales revenue doesn't include tips.
    expect(rep.body.data.summary.revenue).toBe(2 * o.totals.total);
  });
});
