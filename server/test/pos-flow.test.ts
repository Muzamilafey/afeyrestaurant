import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupDb, teardownDb, api, login, uuid, approval, type Session } from './helpers';
import { Product, Table, ModifierGroup, StockBalance, StockLedger, Ingredient, KitchenTicket, Payment, Order, Receipt } from '../src/models';
import { MockSmsProvider } from '../src/integrations/sms/provider';
import { processNotificationQueue } from '../src/services/notify';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let manager: Session;
let chef: Session;
let bartender: Session;
const ids: Record<string, string> = {};

async function stock(name: string, branchId = seed.mainBranchId) {
  const ing = await Ingredient.findOne({ tenantId: seed.tenantId, name }).lean();
  return (await StockBalance.findOne({ tenantId: seed.tenantId, branchId, ingredientId: ing!._id }).lean())?.qty ?? 0;
}

beforeAll(async () => {
  seed = await setupDb();
  [cashier, manager, chef, bartender] = await Promise.all([login('cashier@chili.demo'), login('manager@chili.demo'), login('chef@chili.demo'), login('bartender@chili.demo')]);
  for (const [k, sku] of Object.entries({ burger: 'BRG-001', tusker: 'BR-001', coke: 'SD-001', wine: 'WN-001', curry: 'MN-002' })) ids[k] = String((await Product.findOne({ tenantId: seed.tenantId, sku }).lean())!._id);
  ids.table = String((await Table.findOne({ tenantId: seed.tenantId, branchId: seed.mainBranchId, number: 'M1' }).lean())!._id);
  ids.table2 = String((await Table.findOne({ tenantId: seed.tenantId, branchId: seed.mainBranchId, number: 'M2' }).lean())!._id);
  const done = await ModifierGroup.findOne({ tenantId: seed.tenantId, name: 'Doneness' }).lean();
  ids.doneGroup = String(done!._id);
  ids.medium = String((done!.options[1] as { _id: unknown })._id);
  const extras = await ModifierGroup.findOne({ tenantId: seed.tenantId, name: 'Extras' }).lean();
  ids.extrasGroup = String(extras!._id);
  ids.bacon = String((extras!.options[1] as { _id: unknown })._id);
});
afterAll(teardownDb);

describe('table order → kitchen/bar → payment', () => {
  let orderId: string;
  it('opens a table, validates modifiers and age checks, and creates an order', async () => {
    const missingMod = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'dine_in', tableId: ids.table, items: [{ productId: ids.burger, qty: 1 }] }));
    expect(missingMod.status).toBe(400);
    const noAge = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'dine_in', tableId: ids.table, items: [{ productId: ids.tusker, qty: 1 }] }));
    expect(noAge.body.error.code).toBe('AGE_CHECK_REQUIRED');

    const clientId = uuid();
    const body = {
      clientId, type: 'dine_in', tableId: ids.table, guests: 2,
      items: [
        { productId: ids.burger, qty: 2, modifiers: [{ groupId: ids.doneGroup, optionId: ids.medium }, { groupId: ids.extrasGroup, optionId: ids.bacon }], notes: 'No onions' },
        { productId: ids.tusker, qty: 2, ageCheckConfirmed: true },
      ],
    };
    const r = await cashier.as(api().post('/api/v1/orders').send(body));
    expect(r.status).toBe(201);
    const o = r.body.data;
    orderId = o._id;
    expect(o.items).toHaveLength(2);
    expect(o.items[0].unitPrice).toBe(95000 + 15000);
    expect(o.items[0].station).toBe('kitchen');
    expect(o.items[1].station).toBe('bar');
    expect(o.totals.serviceCharge).toBeGreaterThan(0);
    expect((await Table.findOne({ tenantId: seed.tenantId, _id: ids.table }).lean())!.status).toBe('occupied');
    // Retrying the same submission does not create a duplicate
    const again = await cashier.as(api().post('/api/v1/orders').send(body));
    expect(again.status).toBe(200);
    expect(again.body.data._id).toBe(orderId);
  });

  it('routes food to the kitchen and drinks to the bar exactly once', async () => {
    const key = uuid();
    const s1 = await cashier.as(api().post(`/api/v1/orders/${orderId}/send`).send({ submissionKey: key }));
    expect(s1.status).toBe(200);
    expect(s1.body.data.tickets.map((t: { station: string }) => t.station).sort()).toEqual(['bar', 'kitchen']);
    await cashier.as(api().post(`/api/v1/orders/${orderId}/send`).send({ submissionKey: key }));
    expect(await KitchenTicket.countDocuments({ tenantId: seed.tenantId, orderId })).toBe(2);
    const kds = await chef.as(api().get('/api/v1/stations/kitchen/tickets'));
    const kt = kds.body.data.tickets.find((t: { orderId: string }) => t.orderId === orderId);
    expect(kt.items[0].notes).toBe('No onions');
    expect(JSON.stringify(kds.body.data)).not.toContain('unitPrice');
    const bar = await bartender.as(api().get('/api/v1/stations/bar/tickets'));
    expect(bar.body.data.tickets.some((t: { orderId: string }) => t.orderId === orderId)).toBe(true);
  });

  it('updates preparation and service statuses', async () => {
    const kt = await KitchenTicket.findOne({ tenantId: seed.tenantId, orderId, station: 'kitchen' }).lean();
    const bad = await chef.as(api().post(`/api/v1/stations/tickets/${kt!._id}/status`).send({ status: 'completed' }));
    expect(bad.status).toBe(400);
    for (const s of ['accepted', 'preparing', 'ready']) expect((await chef.as(api().post(`/api/v1/stations/tickets/${kt!._id}/status`).send({ status: s }))).status).toBe(200);
    const o = await Order.findOne({ tenantId: seed.tenantId, _id: orderId }).lean();
    expect(o!.items[0].status).toBe('ready');
    expect(o!.items[1].status).toBe('pending');
    const bt = await KitchenTicket.findOne({ tenantId: seed.tenantId, orderId, station: 'bar' }).lean();
    expect((await chef.as(api().post(`/api/v1/stations/tickets/${bt!._id}/status`).send({ status: 'accepted' }))).status).toBe(403);
    expect((await bartender.as(api().post(`/api/v1/stations/tickets/${bt!._id}/status`).send({ status: 'ready' }))).status).toBe(400);
    expect((await bartender.as(api().post(`/api/v1/stations/tickets/${bt!._id}/status`).send({ status: 'accepted' }))).status).toBe(200);
  });

  it('requires manager approval to void a sent item and records an audit entry', async () => {
    const add = await cashier.as(api().post(`/api/v1/orders/${orderId}/items`).send({ items: [{ productId: ids.coke, qty: 1 }] }));
    const lineId = add.body.data.items[2].lineId;
    await cashier.as(api().post(`/api/v1/orders/${orderId}/send`).send({}));
    const denied = await cashier.as(api().post(`/api/v1/orders/${orderId}/items/${lineId}/void`).send({ reason: 'Customer changed mind' }));
    expect(denied.body.error.code).toBe('APPROVAL_REQUIRED');
    const badPin = await cashier.as(api().post(`/api/v1/orders/${orderId}/items/${lineId}/void`).send({ reason: 'Customer changed mind', approval: { ...approval, pin: '9999' } }));
    expect(badPin.body.error.code).toBe('APPROVAL_INVALID');
    const ok = await cashier.as(api().post(`/api/v1/orders/${orderId}/items/${lineId}/void`).send({ reason: 'Customer changed mind', approval }));
    expect(ok.status).toBe(200);
    expect(ok.body.data.items[2].voided).toBe(true);
  });

  it('requires approval for discounts above the threshold', async () => {
    const big = await cashier.as(api().post(`/api/v1/orders/${orderId}/discount`).send({ type: 'percent', value: 25, reason: 'Regular' }));
    expect(big.body.error.code).toBe('APPROVAL_REQUIRED');
    const small = await cashier.as(api().post(`/api/v1/orders/${orderId}/discount`).send({ type: 'percent', value: 5, reason: 'Regular' }));
    expect(small.status).toBe(200);
    expect(small.body.data.totals.discount).toBeGreaterThan(0);
  });

  it('takes a split payment (cash + card), deducts stock exactly once and prints original then duplicate receipts', async () => {
    const pattyBefore = await stock('Beef patty');
    const beerBefore = await stock('Tusker Lager 500ml');
    const noDrawer = await cashier.as(api().post(`/api/v1/orders/${orderId}/payments`).send({ method: 'cash', amount: 1000, idempotencyKey: uuid() }));
    expect(noDrawer.body.error.code).toBe('NO_CASH_SESSION');
    expect((await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 500000 }))).status).toBe(201);
    const total = (await Order.findOne({ tenantId: seed.tenantId, _id: orderId }).lean())!.totals!.total;
    const cashKey = uuid();
    const cash = await cashier.as(api().post(`/api/v1/orders/${orderId}/payments`).send({ method: 'cash', amount: 100000, tendered: 150000, idempotencyKey: cashKey }));
    expect(cash.status).toBe(201);
    expect(cash.body.data.payment.change).toBe(50000);
    expect(cash.body.data.order.paymentStatus).toBe('partial');
    const retry = await cashier.as(api().post(`/api/v1/orders/${orderId}/payments`).send({ method: 'cash', amount: 100000, tendered: 150000, idempotencyKey: cashKey }));
    expect(retry.body.data.duplicate).toBe(true);
    const over = await cashier.as(api().post(`/api/v1/orders/${orderId}/payments`).send({ method: 'card', amount: total, reference: 'A1', idempotencyKey: uuid() }));
    expect(over.status).toBe(400);
    const card = await cashier.as(api().post(`/api/v1/orders/${orderId}/payments`).send({ method: 'card', amount: total - 100000, reference: 'APPR42', idempotencyKey: uuid() }));
    expect(card.status).toBe(201);
    const paid = card.body.data.order;
    expect(paid.status).toBe('paid');
    expect(paid.receiptNumber).toMatch(/^RC-WST-/);
    expect(await stock('Beef patty')).toBe(pattyBefore - 2);
    expect(await stock('Tusker Lager 500ml')).toBe(beerBefore - 2);
    expect(await StockLedger.countDocuments({ tenantId: seed.tenantId, refId: orderId, type: 'sale' })).toBe(6); // burger: 5 ingredients (one line) + beer: 1; voided coke deducts nothing
    // Closed orders are immutable
    expect((await cashier.as(api().post(`/api/v1/orders/${orderId}/items`).send({ items: [{ productId: ids.coke, qty: 1 }] }))).body.error.code).toBe('ORDER_LOCKED');
    // Table goes to cleaning
    expect((await Table.findOne({ tenantId: seed.tenantId, _id: ids.table }).lean())!.status).toBe('cleaning');
    // Receipt: original, then duplicate needs permission + reason
    const p1 = await cashier.as(api().post(`/api/v1/orders/${orderId}/receipt/print`).send({}));
    expect(p1.body.data.copy).toBe('original');
    expect(p1.body.data.text).not.toContain('DUPLICATE');
    const p2 = await cashier.as(api().post(`/api/v1/orders/${orderId}/receipt/print`).send({ reason: 'Customer copy' }));
    expect(p2.status).toBe(400); // cashier lacks receipts.reprint
    const p3 = await manager.as(api().post(`/api/v1/orders/${orderId}/receipt/print`).send({ reason: 'Customer copy' }));
    expect(p3.body.data.copy).toBe('duplicate');
    expect(p3.body.data.text).toContain('DUPLICATE COPY');
    // A printer failure does not touch the paid transaction
    const fail = await cashier.as(api().post(`/api/v1/orders/${orderId}/receipt/print`).send({ status: 'failed', error: 'Printer offline' }));
    expect(fail.status).toBe(200);
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: orderId }).lean())!.status).toBe('paid');
    expect((await Receipt.findOne({ tenantId: seed.tenantId, orderId }).lean())!.printCount).toBe(2);
  });
});

describe('M-Pesa (simulated provider)', () => {
  async function newOrder() {
    const r = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', customerPhone: '0712345678', items: [{ productId: ids.coke, qty: 2 }] }));
    return r.body.data as { _id: string; totals: { total: number } };
  }

  it('marks an order paid only after a verified successful callback, and ignores duplicates', async () => {
    const o = await newOrder();
    const bad = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0812', amount: o.totals.total, idempotencyKey: uuid() }));
    expect(bad.status).toBe(400);
    const a = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, idempotencyKey: uuid() }));
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('pending');
    expect(a.body.data.callbackTokenHash).toBeDefined; // stored server side only
    // A second prompt while one is pending is refused
    const dup = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, idempotencyKey: uuid() }));
    expect(dup.body.error.code).toBe('MPESA_PENDING');
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean())!.status).toBe('open'); // initiating ≠ paid
    const s = await cashier.as(api().post(`/api/v1/mpesa/simulate/${a.body.data._id}`).send({ resultCode: 0, receipt: 'SIMABC1234' }));
    expect(s.body.data).toMatchObject({ simulated: true, status: 'succeeded' });
    const again = await cashier.as(api().post(`/api/v1/mpesa/simulate/${a.body.data._id}`).send({ resultCode: 0, receipt: 'SIMABC1234' }));
    expect(again.body.data.duplicate).toBe(true);
    const order = await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean();
    expect(order!.status).toBe('paid');
    expect(await Payment.countDocuments({ tenantId: seed.tenantId, orderId: o._id })).toBe(1);
    const p = await Payment.findOne({ tenantId: seed.tenantId, orderId: o._id }).lean();
    expect(p).toMatchObject({ method: 'mpesa', reference: 'SIMABC1234', verification: 'provider' });
    // Payment confirmation SMS is queued and sent through the (simulated) provider
    MockSmsProvider.sent.length = 0;
    await processNotificationQueue();
    expect(MockSmsProvider.sent.some((m) => m.to === '254712345678' && m.message.includes(order!.receiptNumber!))).toBe(true);
  });

  it('never marks an order paid after a failed or mismatched payment', async () => {
    const o = await newOrder();
    const a = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, idempotencyKey: uuid() }));
    const f = await cashier.as(api().post(`/api/v1/mpesa/simulate/${a.body.data._id}`).send({ resultCode: 1032 }));
    expect(f.body.data.status).toBe('cancelled');
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean())!.status).toBe('open');
    const b = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, idempotencyKey: uuid() }));
    const mm = await cashier.as(api().post(`/api/v1/mpesa/simulate/${b.body.data._id}`).send({ resultCode: 0, amount: 1 }));
    expect(mm.body.data.status).toBe('error');
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean())!.status).toBe('open');
    expect(await Payment.countDocuments({ tenantId: seed.tenantId, orderId: o._id })).toBe(0);
  });

  it('authenticates the public STK callback with the per-attempt token', async () => {
    const o = await newOrder();
    const a = await cashier.as(api().post(`/api/v1/orders/${o._id}/mpesa`).send({ phone: '0712345678', amount: o.totals.total, idempotencyKey: uuid() }));
    const attemptId = a.body.data._id;
    const body = { Body: { stkCallback: { MerchantRequestID: a.body.data.merchantRequestId, CheckoutRequestID: a.body.data.checkoutRequestId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: o.totals.total / 100 }, { Name: 'MpesaReceiptNumber', Value: 'FORGED0001' }] } } } };
    const forged = await api().post(`/api/v1/mpesa/callback/stk/${attemptId}/not-the-token`).send(body);
    expect(forged.status).toBe(404);
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: o._id }).lean())!.status).toBe('open');
  });
});

describe('inventory & recipes', () => {
  it('blocks a sale when ingredients are insufficient unless a manager overrides', async () => {
    const tilapia = await Product.findOne({ tenantId: seed.tenantId, sku: 'MN-001' }).lean();
    const items = [{ productId: String(tilapia!._id), qty: 500, modifiers: [{ groupId: String((await ModifierGroup.findOne({ tenantId: seed.tenantId, name: 'Side' }).lean())!._id), optionId: String(((await ModifierGroup.findOne({ tenantId: seed.tenantId, name: 'Side' }).lean())!.options[0] as { _id: unknown })._id) }] }];
    const r = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items }));
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.error.details.shortages[0].name).toBe('Tilapia');
    const o = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items, overrideStockReason: 'Delivery arriving', approval }));
    expect(o.status).toBe(201);
    expect(o.body.data.items[0].stockOverride.reason).toBe('Delivery arriving');
  });

  it('records the recipe version used for each sale so later recipe changes do not rewrite consumption', async () => {
    const chips = await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-001' }).lean();
    const potatoes = await Ingredient.findOne({ tenantId: seed.tenantId, name: 'Potatoes' }).lean();
    const o = await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: String(chips!._id), qty: 1 }] }));
    const v1 = o.body.data.items[0].recipeVersionId;
    // Manager changes the recipe to 500g after the order was taken
    const nv = await manager.as(api().put(`/api/v1/inventory/recipes/${chips!._id}`).send({ lines: [{ ingredientId: String(potatoes!._id), qty: 0.5, unit: 'kg' }] }));
    expect(nv.body.data.version).toBe(2);
    const before = await stock('Potatoes');
    await cashier.as(api().post(`/api/v1/orders/${o.body.data._id}/payments`).send({ method: 'cash', amount: o.body.data.totals.total, idempotencyKey: uuid() }));
    expect(await stock('Potatoes')).toBe(before - 350); // v1 quantity
    const led = await StockLedger.findOne({ tenantId: seed.tenantId, refId: o.body.data._id }).lean();
    expect(String(led!.recipeVersionId)).toBe(v1);
  });

  it('receives goods at FIFO cost and requires a second person to approve wastage', async () => {
    const store = await login('store@chili.demo');
    const sup = (await manager.as(api().get('/api/v1/inventory/suppliers'))).body.data[0];
    const gin = await Ingredient.findOne({ tenantId: seed.tenantId, name: 'Gilbeys Gin 750ml' }).lean();
    const before = await stock('Gilbeys Gin 750ml');
    const grn = await store.as(api().post('/api/v1/inventory/grn').send({ supplierId: sup._id, supplierInvoiceNo: 'INV-77', lines: [{ ingredientId: String(gin!._id), qty: 2, unit: 'bottle', unitPrice: 150000 }] }));
    expect(grn.status).toBe(201);
    expect(await stock('Gilbeys Gin 750ml')).toBe(before + 1500);
    const adj = await store.as(api().post('/api/v1/inventory/adjustments').send({ type: 'breakage', reason: 'Bottle dropped', lines: [{ ingredientId: String(gin!._id), qty: -1, unit: 'bottle' }] }));
    expect(adj.status).toBe(201);
    expect((await store.as(api().post(`/api/v1/inventory/adjustments/${adj.body.data._id}/decision`).send({ approve: true }))).status).toBe(403);
    const ok = await manager.as(api().post(`/api/v1/inventory/adjustments/${adj.body.data._id}/decision`).send({ approve: true }));
    expect(ok.body.data.status).toBe('approved');
    expect(await stock('Gilbeys Gin 750ml')).toBe(before + 750);
  });
});

describe('reports & reconciliation', () => {
  it('generates branch-scoped sales, reconciliation and inventory reports', async () => {
    const sales = await manager.as(api().get('/api/v1/reports/sales').query({ from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(sales.status).toBe(200);
    expect(sales.body.data.summary.orders).toBeGreaterThanOrEqual(3);
    const methods = sales.body.data.payments.map((p: { _id: string }) => p._id).sort();
    expect(methods).toEqual(expect.arrayContaining(['card', 'cash', 'mpesa']));
    const rec = await manager.as(api().get('/api/v1/reports/reconciliation').query({ from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(rec.status).toBe(403); // branch manager lacks financial reports
    const acc = await login('accountant@chili.demo');
    const rec2 = await acc.as(api().get('/api/v1/reports/reconciliation').query({ from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(rec2.body.data.splitPaymentOrders).toBeGreaterThanOrEqual(1);
    const inv = await manager.as(api().get('/api/v1/reports/inventory').query({ from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(inv.body.data.cogs).toBeGreaterThan(0);
    // Other branch has no sales
    const owner = await login('owner@chili.demo');
    const other = await owner.as(api().get('/api/v1/reports/sales').query({ branchId: String(seed.secondBranchId), from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(other.body.data.summary.orders).toBe(0);
    const all = await owner.as(api().get('/api/v1/reports/sales').query({ branchId: 'all', from: new Date(Date.now() - 86400_000).toISOString() }));
    expect(all.body.data.summary.orders).toBe(sales.body.data.summary.orders);
  });

  it('closes the cash drawer with expected vs counted cash', async () => {
    const s = await cashier.as(api().get('/api/v1/cash/session'));
    const expected = s.body.data.expected;
    const close = await cashier.as(api().post('/api/v1/cash/session/close').send({ countedCash: expected - 5000 }));
    expect(close.body.data.variance).toBe(-5000);
  });
});
