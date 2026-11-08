import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { api, login, setupDb, teardownDb, type Session } from './helpers';
import { Ingredient, StockBalance, StockLedger, Supplier } from '../src/models';

let seed: Awaited<ReturnType<typeof setupDb>>;
let manager: Session;
const ingId = new Types.ObjectId();
let supplierId = '';

describe('reorder suggestions', () => {
  beforeAll(async () => {
    seed = await setupDb();
    manager = await login('manager@chili.demo');
    supplierId = String((await Supplier.findOne({ tenantId: seed.tenantId }).lean())!._id);
    // Soda: 12 bottles a day for the last 14 days, 20 bottles left, comes in crates of 24.
    await Ingredient.create({ _id: ingId, tenantId: seed.tenantId, name: 'Test Soda 300ml', baseUnit: 'pcs', units: [{ name: 'crate', factor: 24 }], minLevel: 24, lastCost: 4000, preferredSupplierId: supplierId });
    await StockBalance.create({ tenantId: seed.tenantId, branchId: seed.mainBranchId, ingredientId: ingId, qty: 20 });
    await StockLedger.insertMany(Array.from({ length: 14 }, (_, d) => ({ tenantId: seed.tenantId, branchId: seed.mainBranchId, ingredientId: ingId, type: 'sale', qty: -12, unitCost: 4000, totalCost: 48000, idempotencyKey: `t-sale-${d}`, createdAt: new Date(Date.now() - d * 86400_000 - 3600_000) })));
  });
  afterAll(teardownDb);

  it('suggests enough for the cover period, in whole crates, and turns it into a draft PO', async () => {
    const r = await manager.as(api().get('/api/v1/inventory/reorder-suggestions?days=14&coverDays=7&leadDays=2'));
    expect(r.status).toBe(200);
    const l = r.body.data.items.find((x: { ingredientId: string }) => x.ingredientId === String(ingId));
    expect(l).toMatchObject({ onHand: 20, onOrder: 0, dailyUsage: 12, supplierId, purchaseUnit: { name: 'crate', factor: 24 } });
    // Target 12 × (7 + 2) = 108; need 88 → 4 crates (96).
    expect(l.purchaseUnit.qty).toBe(4);
    expect(l.suggestQty).toBe(96);
    expect(l.estimatedCost).toBe(96 * 4000);

    const po = await manager.as(api().post('/api/v1/inventory/reorder-suggestions/purchase-order').send({ supplierId, lines: [{ ingredientId: String(ingId), qty: 4, unit: 'crate' }] }));
    expect(po.status).toBe(201);
    expect(po.body.data).toMatchObject({ status: 'draft', total: 4 * 24 * 4000 });
    expect(po.body.data.lines[0]).toMatchObject({ unit: 'crate', unitFactor: 24, unitPrice: 96000 });

    // Once submitted, it counts as on order and the suggestion goes away.
    await manager.as(api().post(`/api/v1/inventory/purchase-orders/${po.body.data._id}/status`).send({ status: 'submitted' }));
    const after = await manager.as(api().get('/api/v1/inventory/reorder-suggestions?days=14&coverDays=7&leadDays=2'));
    expect(after.body.data.items.find((x: { ingredientId: string }) => x.ingredientId === String(ingId))).toBeUndefined();
  });
});
