import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, approval, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, Category, KitchenTicket, Product } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let manager: Session;
let cashier: Session;
let combo = '';

describe('combo / set menus', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [manager, cashier] = await Promise.all([login('manager@chili.demo'), login('cashier@chili.demo')]);
    const wings = await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean();
    const coke = await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean();
    const cat = await Category.findOne({ tenantId: seed.tenantId, _id: wings!.categoryId }).lean();
    const r = await manager.as(api().post('/api/v1/menu/products').send({ categoryId: String(cat!._id), name: 'Wings Meal', price: 60000, status: 'available', combo: { isCombo: true, items: [{ productId: String(wings!._id), qty: 1 }, { productId: String(coke!._id), qty: 1 }] } }));
    expect(r.status).toBe(201);
    combo = r.body.data._id;
  });
  afterAll(teardownDb);

  it('charges the combo price once and sends each part to its own station', async () => {
    const o = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: combo, qty: 2 }], sendToStations: true }));
    expect(o.status).toBe(201);
    const items = o.body.data.items as Array<{ lineId: string; name: string; qty: number; unitPrice: number; station: string; parentLineId?: string; status: string }>;
    const parent = items.find((i) => !i.parentLineId)!;
    const parts = items.filter((i) => i.parentLineId === parent.lineId);
    expect(parent).toMatchObject({ name: 'Wings Meal', qty: 2, unitPrice: 60000, station: 'none' });
    expect(parts.map((p) => [p.station, p.qty, p.unitPrice]).sort()).toEqual([['bar', 2, 0], ['kitchen', 2, 0]]);
    expect(o.body.data.totals.subtotal).toBe(120000);
    const tickets = await KitchenTicket.find({ tenantId: seed.tenantId, orderId: o.body.data._id }).lean();
    expect(tickets.map((t) => t.station).sort()).toEqual(['bar', 'kitchen']);
    expect(tickets.find((t) => t.station === 'kitchen')!.items[0].notes).toContain('Part of Wings Meal');

    // Parts change only through the combo.
    expect((await cashier.as(api().post(`/api/v1/orders/${o.body.data._id}/items/${parts[0].lineId}/void`).send({ reason: 'test' }))).status).toBe(409);
    const v = await cashier.as(api().post(`/api/v1/orders/${o.body.data._id}/items/${parent.lineId}/void`).send({ reason: 'Customer changed mind', approval }));
    expect(v.status).toBe(200);
    expect((v.body.data.items as Array<{ voided: boolean }>).every((i) => i.voided)).toBe(true);
    const cancelled = await KitchenTicket.find({ tenantId: seed.tenantId, orderId: o.body.data._id }).lean();
    expect(cancelled.flatMap((t) => t.items.map((i) => i.status))).toEqual(['cancelled', 'cancelled']);
  });

  it('receipt lists the parts under the combo; quantity changes follow; split moves parts along', async () => {
    const o = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: combo, qty: 1 }] }));
    const parent = (o.body.data.items as Array<{ lineId: string; parentLineId?: string }>).find((i) => !i.parentLineId)!;
    const upd = await cashier.as(api().patch(`/api/v1/orders/${o.body.data._id}/items/${parent.lineId}`).send({ qty: 3 }));
    expect((upd.body.data.items as Array<{ qty: number }>).every((i) => i.qty === 3)).toBe(true);
    const bill = await cashier.as(api().get(`/api/v1/orders/${o.body.data._id}/receipt`));
    expect(bill.body.data.text).toContain('Wings Meal');
    expect(bill.body.data.text).toMatch(/incl\. 1 x Chicken Wings/);
    const split = await cashier.as(api().post(`/api/v1/orders/${o.body.data._id}/split`).send({ lines: [{ lineId: parent.lineId, qty: 1 }] }));
    expect(split.status).toBe(200);
    const moved = split.body.data.created.items as Array<{ qty: number; parentLineId?: string; lineId: string }>;
    expect(moved).toHaveLength(3);
    expect(moved.filter((i) => i.parentLineId).every((i) => i.qty === 1 && i.parentLineId === moved.find((x) => !x.parentLineId)!.lineId)).toBe(true);
  });
});
