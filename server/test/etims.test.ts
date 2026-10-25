import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, approval, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, EtimsInvoice, EtimsItem, Order, Product } from '../src/models';
import { MockEtimsClient } from '../src/integrations/etims/oscu';
import { allocate, kraTime, paymentType, processEtims } from '../src/services/etims';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let owner: Session;
let coke = '';
let wings = '';

type Sale = { invcNo: number; orgInvcNo: number; rcptTyCd: string; pmtTyCd: string; totAmt: number; totTaxblAmt: number; totTaxAmt: number; taxblAmtB: number; taxAmtB: number; itemList: Array<{ itemCd: string; itemClsCd: string; qty: number; prc: number; splyAmt: number; dcAmt: number; taxblAmt: number; taxAmt: number; totAmt: number; taxTyCd: string }> };
const sales = () => MockEtimsClient.received.filter((r) => r.path === '/saveTrnsSalesOsdc').map((r) => r.body as unknown as Sale);
const cents = (kes: number) => Math.round(kes * 100);

async function paidOrder(items: Array<{ productId: string; qty: number }>, discountPct = 0) {
  const o = (await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items }))).body.data;
  let total = o.totals.total as number;
  if (discountPct) {
    const d = await cashier.as(api().post(`/api/v1/orders/${o._id}/discount`).send({ type: 'percent', value: discountPct, reason: 'Regular guest', approval }));
    expect(d.status).toBe(200);
    total = d.body.data.totals.total;
  }
  const p = await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ method: 'cash', amount: total, tendered: total, idempotencyKey: uuid() }));
  expect(p.status).toBe(201);
  return { id: o._id as string, total, paymentId: p.body.data.payment._id as string };
}

/** The payment already started a background send; run the queue until the invoice settles. */
async function settle(orderId: string) {
  for (let i = 0; i < 40; i++) {
    await processEtims(seed.tenantId);
    const inv = await EtimsInvoice.findOne({ tenantId: seed.tenantId, orderId, kind: 'sale' }).lean();
    if (inv && (inv.status !== 'queued' || inv.attempts > 0)) return inv;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('invoice never sent');
}

describe('KRA eTIMS', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [cashier, owner] = await Promise.all([login('cashier@chili.demo'), login('owner@chili.demo')]);
    coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    wings = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'ST-002' }).lean())!._id);
    await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 100000 }));
    MockEtimsClient.received.length = 0;
  });
  afterAll(teardownDb);

  it('splits amounts so the parts always add up, and formats Kenyan time', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(999, [500, 0, 250]).reduce((a, b) => a + b, 0)).toBe(999);
    expect(kraTime(new Date('2026-10-25T21:30:05Z'))).toBe('20261026003005');
    expect(paymentType(['cash'])).toBe('01');
    expect(paymentType(['mpesa', 'mpesa'])).toBe('06');
    expect(paymentType(['cash', 'mpesa'])).toBe('07');
  });

  it('sends nothing while switched off, then signs each paid sale with the next invoice number', async () => {
    const before = await paidOrder([{ productId: coke, qty: 1 }]);
    const on = await owner.as(api().put('/api/v1/integrations/etims').send({ provider: 'mock', enabled: true, settings: { defaultItemClass: '5020220100' } }));
    expect(on.status).toBe(200);
    await processEtims(seed.tenantId);
    // Sales from before eTIMS was switched on are not sent, and their receipts say nothing about KRA.
    expect(await EtimsInvoice.countDocuments({ tenantId: seed.tenantId, orderId: before.id })).toBe(0);
    expect((await cashier.as(api().get(`/api/v1/orders/${before.id}/receipt`))).body.data.text).not.toContain('KRA eTIMS');

    const a = await paidOrder([{ productId: wings, qty: 2 }, { productId: coke, qty: 3 }]);
    const inv = await settle(a.id);
    expect(inv).toMatchObject({ invcNo: 1, status: 'signed', kind: 'sale', amount: a.total, simulated: true });
    const body = sales().find((s) => s.invcNo === 1)!;
    expect(body).toMatchObject({ rcptTyCd: 'S', pmtTyCd: '01', orgInvcNo: 0 });
    expect(cents(body.totAmt)).toBe(a.total);
    expect(body.itemList.reduce((s, i) => s + cents(i.taxblAmt), 0)).toBe(a.total);
    for (const i of body.itemList) {
      expect(i.itemCd).toMatch(/^KE[23]NTU\d{7}$/);
      expect(cents(i.splyAmt)).toBe(Math.round(cents(i.prc) * i.qty));
      expect(cents(i.splyAmt) - cents(i.dcAmt)).toBe(cents(i.taxblAmt));
    }
    // Prices include 16% VAT: the tax is 16/116 of the taxable amount.
    expect(Math.abs(cents(body.totTaxAmt) - Math.round((a.total * 16) / 116))).toBeLessThanOrEqual(body.itemList.length);
    expect(await EtimsItem.countDocuments({ tenantId: seed.tenantId })).toBe(body.itemList.length);

    const receipt = await cashier.as(api().get(`/api/v1/orders/${a.id}/receipt`));
    expect(receipt.body.data.text).toContain('KRA eTIMS');
    expect(receipt.body.data.text).toContain('SIMULATED - NOT SENT TO KRA');
    expect(receipt.body.data.doc.lines).toContainEqual({ k: 'qr', data: expect.stringContaining('indexEtimsReceiptData?Data=') });
  });

  it('spreads an order discount over the lines and registers each item only once', async () => {
    const itemsBefore = MockEtimsClient.received.filter((r) => r.path === '/saveItem').length;
    const b = await paidOrder([{ productId: wings, qty: 1 }, { productId: coke, qty: 1 }], 10);
    const inv = await settle(b.id);
    expect(inv).toMatchObject({ invcNo: 2, status: 'signed' });
    const body = sales().find((s) => s.invcNo === 2)!;
    expect(cents(body.totAmt)).toBe(b.total);
    expect(body.itemList.every((i) => i.dcAmt > 0)).toBe(true);
    expect(MockEtimsClient.received.filter((r) => r.path === '/saveItem').length).toBe(itemsBefore);
  });

  it('keeps the invoice number while KRA is unreachable and resends it later', async () => {
    MockEtimsClient.failNext = 1;
    const c = await paidOrder([{ productId: coke, qty: 1 }]);
    const failed = await settle(c.id);
    expect(failed).toMatchObject({ invcNo: 3, status: 'queued', attempts: 1 });
    expect(failed.lastError).toContain('simulated outage');
    const pending = await cashier.as(api().get(`/api/v1/orders/${c.id}/receipt`));
    expect(pending.body.data.text).toContain('KRA eTIMS invoice is being signed');

    await EtimsInvoice.updateOne({ tenantId: seed.tenantId, _id: failed._id }, { $set: { nextAttemptAt: new Date() } });
    await processEtims(seed.tenantId);
    const ok = await EtimsInvoice.findOne({ tenantId: seed.tenantId, _id: failed._id }).lean();
    expect(ok).toMatchObject({ invcNo: 3, status: 'signed', attempts: 2 });
    expect((await Order.findOne({ tenantId: seed.tenantId, _id: c.id }).lean())!.fiscal?.invcNo).toBe(3);
  });

  it('reports a refund as a credit note against the signed sale', async () => {
    const d = await paidOrder([{ productId: wings, qty: 2 }]);
    const sale = await settle(d.id);
    const half = Math.round(d.total / 2);
    const r = await cashier.as(api().post(`/api/v1/orders/payments/${d.paymentId}/refund`).send({ amount: half, reason: 'Cold food', idempotencyKey: uuid(), approval }));
    expect(r.status).toBe(200);
    let credit = null;
    for (let i = 0; i < 40 && credit?.status !== 'signed'; i++) {
      await processEtims(seed.tenantId);
      credit = await EtimsInvoice.findOne({ tenantId: seed.tenantId, orderId: d.id, kind: 'credit_note' }).lean();
    }
    expect(credit).toMatchObject({ invcNo: sale.invcNo + 1, orgInvcNo: sale.invcNo, amount: half, status: 'signed' });
    const body = sales().find((s) => s.invcNo === credit!.invcNo)!;
    expect(body).toMatchObject({ rcptTyCd: 'R', orgInvcNo: sale.invcNo });
    expect(cents(body.totAmt)).toBe(half);
  });

  it('shows the status and lets a manager resend a refused invoice', async () => {
    const st = await owner.as(api().get('/api/v1/etims'));
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ enabled: true, simulated: true, lastInvcNo: 5 });
    expect(st.body.data.counts.signed).toBe(5);
    expect((await cashier.as(api().get('/api/v1/etims'))).status).toBe(403);

    const inv = await EtimsInvoice.findOne({ tenantId: seed.tenantId, invcNo: 3 }).lean();
    await EtimsInvoice.updateOne({ tenantId: seed.tenantId, _id: inv!._id }, { $set: { status: 'rejected', lastError: 'KRA 910: Request parameter error' } });
    const again = await owner.as(api().post(`/api/v1/etims/invoices/${inv!._id}/retry`));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ invcNo: 3, status: 'signed' });
  });

  it('initialises a (simulated) device and stores the key as a secret', async () => {
    expect((await owner.as(api().post('/api/v1/etims/initialize').send({ tin: 'nonsense', deviceSerial: 'X1' }))).status).toBe(400);
    const r = await owner.as(api().post('/api/v1/etims/initialize').send({ tin: 'p051234567a', bhfId: '00', deviceSerial: 'KRACU0100000001', simulated: true }));
    expect(r.status).toBe(200);
    const overview = await owner.as(api().get('/api/v1/integrations'));
    const cfg = overview.body.data.integrations.find((i: { kind: string }) => i.kind === 'etims').config;
    expect(cfg.settings).toMatchObject({ tin: 'P051234567A', bhfId: '00', defaultItemClass: '5020220100' });
    expect(JSON.stringify(cfg)).not.toContain(r.body.data.cmcKey ?? 'no-key-in-response');
    expect(cfg.secretHints.cmcKey).toBeTruthy();
  });
});
