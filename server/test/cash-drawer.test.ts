import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupDb, teardownDb, api, login, uuid, type Session } from './helpers';
import { CashSession, Payment, Product } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let manager: Session;
let owner: Session;
let wings: string;

beforeAll(async () => {
  seed = await setupDb();
  [cashier, manager, owner] = await Promise.all([login('cashier@chili.demo'), login('manager@chili.demo'), login('owner@chili.demo')]);
  wings = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean())!._id);
});
afterAll(teardownDb);

const setMode = (mode: 'per_user' | 'shared') => owner.as(api().patch(`/api/v1/admin/branches/${seed.mainBranchId}`).send({ settings: { cashDrawerMode: mode } }));
async function sale(by: Session) {
  const o = await by.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: wings, qty: 1 }] }));
  expect(o.status).toBe(201);
  return by.as(api().post(`/api/v1/orders/${o.body.data._id}/payments`).send({ method: 'cash', amount: o.body.data.totals.total, tendered: o.body.data.totals.total, idempotencyKey: uuid() }));
}

describe('cash drawer mode (per user or one shared drawer)', () => {
  it('per user (default): each person needs their own drawer', async () => {
    expect((await cashier.as(api().get('/api/v1/cash/mode'))).body.data.mode).toBe('per_user');
    expect((await sale(cashier)).body.error.code).toBe('NO_CASH_SESSION');
    expect((await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 100000 }))).status).toBe(201);
    expect((await sale(cashier)).status).toBe(201);
    expect((await sale(manager)).body.error.code).toBe('NO_CASH_SESSION'); // the cashier's drawer is not the manager's
  });

  it('only an admin can choose the mode, and not while any drawer is open', async () => {
    expect((await manager.as(api().patch(`/api/v1/admin/branches/${seed.mainBranchId}`).send({ settings: { cashDrawerMode: 'shared' } }))).status).toBe(403);
    const r = await setMode('shared');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DRAWERS_OPEN');
    expect((await cashier.as(api().post('/api/v1/cash/session/close').send({ countedCash: 100000 + 55000 }))).status).toBe(200);
    expect((await setMode('shared')).status).toBe(200);
    expect((await cashier.as(api().get('/api/v1/cash/mode'))).body.data.mode).toBe('shared');
  });

  it('shared: one drawer opened once, everyone takes cash into it, counted once', async () => {
    expect((await sale(cashier)).body.error.message).toMatch(/shared cash drawer is not open/);
    const open = await manager.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 200000 }));
    expect(open.status).toBe(201);
    expect(open.body.data.shared).toBe(true);
    // A second person cannot open another one.
    const again = await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 5000 }));
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/shared cash drawer is already open/);

    const p1 = await sale(cashier);
    const p2 = await sale(manager);
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    const ids = [p1.body.data.payment._id, p2.body.data.payment._id];
    for (const id of ids) expect(String((await Payment.findOne({ tenantId: seed.tenantId, _id: id }).lean())!.cashSessionId)).toBe(open.body.data._id);

    // Both see the same drawer, with both people's cash in it.
    const view = await cashier.as(api().get('/api/v1/cash/session'));
    expect(view.body.data._id).toBe(open.body.data._id);
    expect(view.body.data.totals.cashSales).toBe(2 * 55000);
    expect(view.body.data.expected).toBe(200000 + 2 * 55000);
    // Cashier sees the shared drawer in their history without view-all permission.
    expect((await cashier.as(api().get('/api/v1/cash/sessions'))).body.data.some((s: { _id: string }) => s._id === open.body.data._id)).toBe(true);

    const closed = await cashier.as(api().post('/api/v1/cash/session/close').send({ countedCash: 200000 + 2 * 55000 - 1000 }));
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'closed', variance: -1000, expectedCash: 310000 });
    expect(await CashSession.countDocuments({ tenantId: seed.tenantId, branchId: seed.mainBranchId, status: 'open' })).toBe(0);
    expect((await setMode('per_user')).status).toBe(200);
  });
});
