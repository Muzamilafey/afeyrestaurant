import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Product, Role, Tenant } from '../src/models';
import { runUpgrades } from '../src/services/upgrades';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let waiter: Session;
let manager: Session;
let coke = '';

describe('who sees which open orders on the POS', () => {
  beforeAll(async () => {
    seed = await setupDb();
    [cashier, waiter, manager] = await Promise.all([login('cashier@chili.demo'), login('waiter@chili.demo'), login('manager@chili.demo')]);
    coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
  });
  afterAll(teardownDb);

  it('staff see only their own open orders; managers (orders.view_all) see everyone’s', async () => {
    const mine = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 1 }] }));
    const theirs = await waiter.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 1 }] }));
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const ids = async (s: Session) => ((await s.as(api().get('/api/v1/tables'))).body.data.takeaway as Array<{ id: string }>).map((o) => o.id);
    expect(await ids(cashier)).toContain(mine.body.data._id);
    expect(await ids(cashier)).not.toContain(theirs.body.data._id);
    expect(await ids(waiter)).toEqual(expect.arrayContaining([theirs.body.data._id]));
    expect(await ids(waiter)).not.toContain(mine.body.data._id);
    expect(await ids(manager)).toEqual(expect.arrayContaining([mine.body.data._id, theirs.body.data._id]));

    // Held orders list on the POS follows the same rule.
    await waiter.as(api().post(`/api/v1/orders/${theirs.body.data._id}/hold`).send({}));
    const held = async (s: Session) => ((await s.as(api().get('/api/v1/orders?status=held&mine=1'))).body.data as Array<{ _id: string }>).map((o) => o._id);
    expect(await held(cashier)).not.toContain(theirs.body.data._id);
    expect(await held(manager)).toContain(theirs.body.data._id);
  });

  it('existing businesses: managers get orders.view_all once, and an admin’s later change is kept', async () => {
    await Role.updateOne({ tenantId: seed.tenantId, key: 'branch_manager' }, { $pull: { permissions: 'orders.view_all' } });
    await Tenant.updateOne({ _id: seed.tenantId }, { $unset: { 'settings.ordersViewAllUpgraded': 1 } });
    await runUpgrades();
    expect((await Role.findOne({ tenantId: seed.tenantId, key: 'branch_manager' }).lean())!.permissions).toContain('orders.view_all');
    expect((await Role.findOne({ tenantId: seed.tenantId, key: 'cashier' }).lean())!.permissions).not.toContain('orders.view_all');
    await Role.updateOne({ tenantId: seed.tenantId, key: 'branch_manager' }, { $pull: { permissions: 'orders.view_all' } });
    await runUpgrades();
    expect((await Role.findOne({ tenantId: seed.tenantId, key: 'branch_manager' }).lean())!.permissions).not.toContain('orders.view_all');
  });
});
