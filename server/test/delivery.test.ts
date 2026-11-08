import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, Product } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let manager: Session;
let cashier: Session;
let chef: Session;
let wings = '';

describe('delivery riders', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [manager, cashier, chef] = await Promise.all([login('manager@chili.demo'), login('cashier@chili.demo'), login('chef@chili.demo')]);
    wings = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean())!._id);
  });
  afterAll(teardownDb);

  let riderId = '';
  it('registers, lists and deactivates riders (delivery managers only)', async () => {
    const denied = await cashier.as(api().post('/api/v1/crm/riders').send({ name: 'Not allowed' }));
    expect(denied.status).toBe(403);
    const r = await manager.as(api().post('/api/v1/crm/riders').send({ name: 'Brian Rider', phone: '0712 000 111', vehicle: 'Motorbike', plate: 'KMEA 123B' }));
    expect(r.status).toBe(201);
    expect(r.body.data.phone).toBe('254712000111');
    riderId = r.body.data._id;
    const spare = await manager.as(api().post('/api/v1/crm/riders').send({ name: 'Spare Rider' }));
    expect((await manager.as(api().patch(`/api/v1/crm/riders/${spare.body.data._id}`).send({ active: false }))).body.data.active).toBe(false);
    // Anyone who takes orders can see the riders to assign one.
    const list = await cashier.as(api().get('/api/v1/crm/riders'));
    expect(list.status).toBe(200);
    expect(list.body.data.find((x: { _id: string }) => x._id === riderId).activeDeliveries).toBe(0);
    // An inactive rider can't be given an order.
    const bad = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'delivery', delivery: { address: 'Kilimani, Argwings Kodhek Rd', riderId: spare.body.data._id }, items: [{ productId: wings, qty: 1 }] }));
    expect(bad.status).toBe(400);
  });

  it('assigns the rider while placing the order, and any user can mark it delivered', async () => {
    const o = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'delivery', customerName: 'Jane', customerPhone: '0712345678', delivery: { address: 'Kilimani, Argwings Kodhek Rd', riderId }, items: [{ productId: wings, qty: 1 }], sendToStations: true }));
    expect(o.status).toBe(201);
    expect(o.body.data.delivery).toMatchObject({ riderName: 'Brian Rider', status: 'assigned' });
    expect((await cashier.as(api().get('/api/v1/crm/riders'))).body.data.find((x: { _id: string }) => x._id === riderId).activeDeliveries).toBe(1);

    // The chef has no delivery permissions but can still confirm the drop-off.
    const d = await chef.as(api().post(`/api/v1/crm/delivery/${o.body.data._id}/delivered`).send({}));
    expect(d.status).toBe(200);
    expect(d.body.data.delivery.status).toBe('delivered');
    expect(d.body.data.delivery.deliveredBy).toBe((await chef.as(api().get('/api/v1/auth/me'))).body.data.user.name);
    expect(d.body.data.delivery.deliveredAt).toBeTruthy();
    const done = await cashier.as(api().get('/api/v1/crm/delivery?done=1'));
    expect(done.body.data.some((x: { _id: string }) => x._id === o.body.data._id)).toBe(true);
    const active = await cashier.as(api().get('/api/v1/crm/delivery'));
    expect(active.body.data.some((x: { _id: string }) => x._id === o.body.data._id)).toBe(false);
  });
});
