import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { AuditLog, Product } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let chef: Session;
let cashier: Session;
let wings = '';

describe('sold out (86) in one tap', () => {
  beforeAll(async () => {
    seed = await setupDb();
    [chef, cashier] = await Promise.all([login('chef@chili.demo'), login('cashier@chili.demo')]);
    wings = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean())!._id);
  });
  afterAll(teardownDb);

  it('the kitchen marks an item sold out for today; tills cannot sell it; it is back on sale the next day', async () => {
    const r = await chef.as(api().post(`/api/v1/menu/products/${wings}/sold-out`).send({ soldOut: true }));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'sold_out' });
    expect(new Date(r.body.data.soldOutUntil).getTime()).toBeGreaterThan(Date.now());
    expect(await AuditLog.exists({ tenantId: seed.tenantId, action: 'menu.sold_out' })).toBeTruthy();

    const cat = await cashier.as(api().get('/api/v1/menu/catalog'));
    expect(cat.body.data.products.find((p: { _id: string }) => p._id === wings)).toMatchObject({ available: false, unavailableReason: 'sold_out' });
    const sell = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: wings, qty: 1 }] }));
    expect(sell.status).toBe(409);
    expect(sell.body.error.message).toMatch(/sold out/);

    // Next business day: available again without anyone switching it back.
    await Product.updateOne({ tenantId: seed.tenantId, _id: wings }, { $set: { soldOutUntil: new Date(Date.now() - 1000) } });
    const again = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: wings, qty: 1 }] }));
    expect(again.status).toBe(201);
    expect((await Product.findOne({ tenantId: seed.tenantId, _id: wings }).lean())!.status).toBe('available');
  });

  it('a cashier can mark it until switched back, and put it back on sale', async () => {
    const r = await cashier.as(api().post(`/api/v1/menu/products/${wings}/sold-out`).send({ soldOut: true, until: 'manual' }));
    expect(r.body.data.soldOutUntil ?? null).toBeNull();
    const back = await cashier.as(api().post(`/api/v1/menu/products/${wings}/sold-out`).send({ soldOut: false }));
    expect(back.body.data.status).toBe('available');
  });
});
