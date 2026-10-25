import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, KitchenTicket, Order, Product, Table } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let owner: Session;
let manager: Session;
let waiter: Session;
let path = '';
let tableId = '';
let wings = '';
let coke = '';

const guest = (p: string) => `/api/v1/qr${p}`;

describe('QR table ordering', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [owner, manager, waiter] = await Promise.all([login('owner@chili.demo'), login('manager@chili.demo'), login('waiter@chili.demo')]);
    wings = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean())!._id);
    coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    const codes = await manager.as(api().get('/api/v1/qr/codes'));
    expect(codes.status).toBe(200);
    path = codes.body.data[0].path;
    tableId = codes.body.data[0].tableId;
    expect(path).toMatch(/^\/t\/[a-f0-9]{32}$/);
  });
  afterAll(teardownDb);

  it('is off until the branch switches it on, and the token is not shown on the floor plan', async () => {
    const off = await api().get(guest(path));
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('QR_ORDERING_OFF');
    expect((await api().get(guest('/t/nothex'))).status).toBe(404);
    const plan = await waiter.as(api().get('/api/v1/tables'));
    expect(plan.body.data.tables.every((t: Record<string, unknown>) => !('qrToken' in t))).toBe(true);

    const r = await owner.as(api().patch(`/api/v1/admin/branches/${owner.branchId}`).send({ settings: { qrOrdering: { enabled: true, requireAccept: true, payByMpesa: true } } }));
    expect(r.status).toBe(200);
    const menu = await api().get(guest(path));
    expect(menu.status).toBe(200);
    expect(menu.body.data.table.number).toBeTruthy();
    const ids = (menu.body.data.products as Array<{ id: string; name: string }>).map((p) => p.id);
    expect(ids).toContain(wings);
    // Age-restricted drinks are never sold to an anonymous phone.
    const beer = await Product.findOne({ tenantId: seed.tenantId, sku: 'BR-001' }).lean();
    expect(ids).not.toContain(String(beer!._id));
  });

  it('holds a guest order until a waiter accepts it, then sends it to the kitchen and bar', async () => {
    const o = await api().post(guest(`${path}/orders`)).send({ clientId: uuid(), items: [{ productId: wings, qty: 1 }], name: 'Amina' });
    expect(o.status).toBe(201);
    expect(o.body.data).toMatchObject({ waitingForStaff: true, total: expect.any(Number) });
    const id = o.body.data.id as string;
    expect(await KitchenTicket.countDocuments({ tenantId: seed.tenantId, orderId: id })).toBe(0);

    // The guest adds a drink to the same order.
    const more = await api().post(guest(`${path}/orders`)).send({ clientId: uuid(), orderId: id, items: [{ productId: coke, qty: 2 }] });
    expect(more.status).toBe(201);
    expect(more.body.data.id).toBe(id);
    expect(more.body.data.items).toHaveLength(2);

    // A waiter without "see all orders" still sees the QR order waiting for acceptance.
    const plan = await waiter.as(api().get('/api/v1/tables'));
    const tile = plan.body.data.tables.find((t: { _id: string }) => t._id === tableId);
    expect(tile.orders).toEqual([expect.objectContaining({ id, qr: true, qrPending: true })]);

    // Paying is refused while the order is waiting.
    const early = await api().post(guest(`${path}/orders/${id}/mpesa`)).send({ phone: '0712345678', idempotencyKey: uuid() });
    expect(early.status).toBe(409);

    const acc = await waiter.as(api().post(`/api/v1/qr/orders/${id}/accept`));
    expect(acc.status).toBe(200);
    const tickets = await KitchenTicket.find({ tenantId: seed.tenantId, orderId: id }).lean();
    expect(tickets.map((t) => t.station).sort()).toEqual(['bar', 'kitchen']);
    const saved = await Order.findOne({ tenantId: seed.tenantId, _id: id }).lean();
    expect(saved!.qrPending).toBeFalsy();
    expect(saved!.source).toBe('qr');
    expect(saved!.customerName).toBe('Amina');

    const status = await api().get(guest(`${path}/orders/${id}`));
    expect(status.body.data.waitingForStaff).toBe(false);
    expect(status.body.data.items.every((i: { status: string }) => i.status !== 'waiting')).toBe(true);
  });

  it('lets the guest call a waiter and staff answer it', async () => {
    const c = await api().post(guest(`${path}/call`)).send({ reason: 'bill' });
    expect(c.status).toBe(200);
    expect((await Table.findOne({ tenantId: seed.tenantId, _id: tableId }).lean())!.call?.reason).toBe('bill');
    expect((await api().post(guest(`${path}/call`)).send({ reason: 'bill' })).body.data.repeated).toBe(true);
    const plan = await waiter.as(api().get('/api/v1/tables'));
    expect(plan.body.data.tables.find((t: { _id: string }) => t._id === tableId).call.reason).toBe('bill');
    expect((await waiter.as(api().post(`/api/v1/qr/tables/${tableId}/call/clear`))).status).toBe(200);
    expect((await Table.findOne({ tenantId: seed.tenantId, _id: tableId }).lean())!.call?.reason).toBeUndefined();
  });

  it('lets the guest pay the balance by M-Pesa prompt', async () => {
    const id = String((await Order.findOne({ tenantId: seed.tenantId, tableId, source: 'qr' }).lean())!._id);
    const p = await api().post(guest(`${path}/orders/${id}/mpesa`)).send({ phone: '0712345678', idempotencyKey: uuid() });
    expect(p.status).toBe(200);
    const o = await Order.findOne({ tenantId: seed.tenantId, _id: id }).lean();
    expect(p.body.data.amount).toBe(o!.totals!.total - (o!.totals!.total % 100));
    expect((await manager.as(api().post(`/api/v1/mpesa/simulate/${p.body.data.attemptId}`).send({ resultCode: 0 }))).status).toBe(200);
    const s = await api().get(guest(`${path}/orders/${id}/mpesa/${p.body.data.attemptId}`));
    expect(s.body.data.status).toBe('succeeded');
    const after = await api().get(guest(`${path}/orders/${id}`));
    expect(after.body.data.paid).toBe(p.body.data.amount);
  });

  it('cannot read orders of another table, and a new code retires the old sticker', async () => {
    const other = (await manager.as(api().get('/api/v1/qr/codes'))).body.data[1];
    const id = String((await Order.findOne({ tenantId: seed.tenantId, tableId, source: 'qr' }).lean())!._id);
    expect((await api().get(guest(`${other.path}/orders/${id}`))).status).toBe(404);
    expect((await waiter.as(api().get('/api/v1/qr/codes'))).status).toBe(403);
    const r = await manager.as(api().post(`/api/v1/qr/codes/${tableId}/regenerate`));
    expect(r.body.data.path).not.toBe(path);
    expect((await api().get(guest(path))).status).toBe(404);
    expect((await api().get(guest(r.body.data.path))).status).toBe(200);
  });

  it('counts staff sending a waiting QR order to the kitchen as accepting it', async () => {
    const code = (await manager.as(api().get('/api/v1/qr/codes'))).body.data[3].path;
    const o = await api().post(guest(`${code}/orders`)).send({ clientId: uuid(), items: [{ productId: wings, qty: 1 }] });
    const id = o.body.data.id as string;
    expect((await waiter.as(api().post(`/api/v1/orders/${id}/send`).send({})))).toHaveProperty('status', 200);
    const saved = await Order.findOne({ tenantId: seed.tenantId, _id: id }).lean();
    expect(saved!.qrPending).toBeFalsy();
    expect(saved!.waiterName).not.toBe('QR order');
    expect(await KitchenTicket.countDocuments({ tenantId: seed.tenantId, orderId: id })).toBe(1);
  });

  it('limits how many orders one table can send in an hour', async () => {
    const code = (await manager.as(api().get('/api/v1/qr/codes'))).body.data[2].path;
    let last = 0;
    for (let i = 0; i < 16; i++) last = (await api().post(guest(`${code}/orders`)).send({ clientId: uuid(), items: [{ productId: coke, qty: 1 }] })).status;
    expect(last).toBe(429);
  });
});
