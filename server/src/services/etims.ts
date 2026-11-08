import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { mocksAllowed } from '../config/env';
import { withTransaction } from '../db/connect';
import { Branch, EtimsCounter, EtimsInvoice, EtimsItem, IntegrationConfiguration, Order, Payment, Product, Refund, Tenant } from '../models';
import { EtimsError, MockEtimsClient, OSCU_URLS, OscuClient, RECEIPT_URLS, type EtimsClient } from '../integrations/etims/oscu';
import { loadIntegration, recordIntegrationResult } from './integrations';
import { logger } from '../lib/logger';

/**
 * KRA eTIMS through OSCU. A paid sale gets the next KRA invoice number (in the order sales were paid), then is sent
 * with its lines; KRA answers with a signature that is printed on the receipt. Refunds are sent as credit notes
 * against the signed sale. Failed sends are retried with the same number; nothing here blocks taking payment.
 */

export const TAX_RATES: Record<string, number> = { A: 0, B: 16, C: 0, D: 0, E: 8 };
const OPERATOR = { regrId: 'chili-pos', regrNm: 'Chili POS', modrId: 'chili-pos', modrNm: 'Chili POS' };

export interface EtimsSettings {
  tin?: string;
  bhfId?: string;
  deviceSerial?: string;
  /** KRA item classification used for products without their own. */
  defaultItemClass?: string;
  /** Tax type for items with VAT at a rate other than 16% / 8%, and for items without tax. */
  defaultTaxType?: string;
  untaxedTaxType?: string;
  /** Sales paid before this moment are not sent (they were declared another way). */
  startFrom?: string;
  /** Last invoice number already used with KRA for this PIN + branch (when moving from another system). */
  startAfterInvcNo?: number;
  baseUrl?: string;
}

export interface EtimsHandle {
  tenantId: Types.ObjectId;
  client: EtimsClient;
  settings: EtimsSettings;
  tin: string;
  bhfId: string;
  series: string;
  environment: 'sandbox' | 'production';
  startFrom: Date;
}

export const isValidKraPin = (s: string) => /^[AP]\d{9}[A-Z]$/.test(s);

/** The configured eTIMS connection, or null when eTIMS is switched off. Throws EtimsError('config') when unusable. */
export async function getEtims(tenantId: Types.ObjectId): Promise<EtimsHandle | null> {
  const cfg = await loadIntegration(tenantId, 'etims');
  if (!cfg?.enabled) return null;
  const s = cfg.settings as EtimsSettings;
  const tin = (s.tin ?? '').trim().toUpperCase();
  const bhfId = (s.bhfId ?? '00').trim() || '00';
  const environment = cfg.environment === 'production' ? 'production' : 'sandbox';
  const startFrom = s.startFrom ? new Date(s.startFrom) : new Date(0);
  if (cfg.provider === 'mock') {
    if (!mocksAllowed) throw new EtimsError('The simulated KRA eTIMS connection is disabled in production', 'config');
    const t = tin || 'P000000000A';
    return { tenantId, client: new MockEtimsClient(), settings: s, tin: t, bhfId, series: `${t}-${bhfId}-sim`, environment: 'sandbox', startFrom };
  }
  if (!isValidKraPin(tin)) throw new EtimsError('Enter the business KRA PIN (e.g. P051234567A) under Integrations → KRA eTIMS', 'config');
  if (!/^\d{2}$/.test(bhfId)) throw new EtimsError('The KRA branch ID is two digits: 00 for the head office', 'config');
  if (!cfg.secrets.cmcKey) throw new EtimsError('Initialise the OSCU device first (Integrations → KRA eTIMS → Initialise device)', 'config');
  const client = new OscuClient({ baseUrl: s.baseUrl || OSCU_URLS[environment], tin, bhfId, cmcKey: cfg.secrets.cmcKey });
  return { tenantId, client, settings: s, tin, bhfId, series: `${tin}-${bhfId}`, environment, startFrom };
}

// ───────────────────────────── Amounts ─────────────────────────────

const kes = (cents: number) => Math.round(cents) / 100;
/** Split `total` cents over `weights` in proportion; rounding goes to the largest weight so the parts add up. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const big = weights.indexOf(Math.max(...weights));
  parts[big] += total - parts.reduce((a, p) => a + p, 0);
  return parts;
}

/** Kenyan time (EAT, UTC+3, no daylight saving) as yyyyMMddHHmmss. */
export function kraTime(d: Date) {
  const t = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

interface SaleLine { key: string; name: string; qty: number; prc: number; supply: number; target: number; taxTyCd: string; itemClsCd: string; itemTyCd: '2' | '3' }

/**
 * The order as KRA invoice lines. Prices are VAT-inclusive, as eTIMS requires; the order discount is spread over the
 * lines as line discounts; service charge and delivery fee are their own (service) lines. The line amounts always
 * add up to the order total printed on the receipt.
 */
export async function saleLines(h: Pick<EtimsHandle, 'settings'>, order: { tenantId: unknown; items: any[]; totals?: any }) {
  const s = h.settings;
  const live = order.items.filter((i) => !i.voided && !i.parentLineId && i.qty > 0);
  const products = await Product.find({ tenantId: order.tenantId, _id: { $in: live.map((i) => i.productId) } }, { etims: 1, name: 1 }).lean();
  const fees = [
    { key: 'fee:service_charge', name: 'Service charge', cents: order.totals?.serviceCharge ?? 0 },
    { key: 'fee:delivery', name: 'Delivery fee', cents: order.totals?.deliveryFee ?? 0 },
  ].filter((f) => f.cents > 0);
  const base = live.map((i) => {
    const p = products.find((x) => String(x._id) === String(i.productId));
    const excl = (i.taxes ?? []).filter((t: any) => !t.inclusive).reduce((a: number, t: any) => a + (t.amount ?? 0), 0);
    const gross = (i.lineTotal ?? 0) + excl;
    const factor = i.lineTotal > 0 ? gross / i.lineTotal : 1;
    const prc = Math.round((i.unitPrice ?? 0) * factor);
    const rates: number[] = (i.taxes ?? []).map((t: any) => t.rateBps ?? 0);
    const taxTyCd = p?.etims?.taxTyCd || (rates.includes(1600) ? 'B' : rates.includes(800) ? 'E' : rates.some((r) => r > 0) ? s.defaultTaxType || 'B' : s.untaxedTaxType || 'A');
    return { key: `product:${i.productId}`, name: i.name as string, qty: i.qty as number, prc, supply: Math.round(prc * i.qty), gross: i.complimentary ? 0 : gross, taxTyCd, itemClsCd: p?.etims?.itemClsCd || s.defaultItemClass || '', itemTyCd: '2' as const };
  });
  // What the items must add up to after the order discount.
  const itemsTotal = (order.totals?.total ?? 0) - fees.reduce((a, f) => a + f.cents, 0);
  const targets = allocate(Math.max(0, itemsTotal), base.map((b) => b.gross));
  const lines: SaleLine[] = base.map((b, n) => ({ key: b.key, name: b.name, qty: b.qty, prc: b.prc, supply: b.supply, target: Math.min(targets[n], b.supply), taxTyCd: b.taxTyCd, itemClsCd: b.itemClsCd, itemTyCd: b.itemTyCd }));
  for (const f of fees) lines.push({ key: f.key, name: f.name, qty: 1, prc: f.cents, supply: f.cents, target: f.cents, taxTyCd: s.defaultTaxType || 'B', itemClsCd: s.defaultItemClass || '', itemTyCd: '3' });
  return lines;
}

/** The request body for /saveTrnsSalesOsdc (KRA adds tin/bhfId/cmcKey from the client). */
export function saleBody(lines: SaleLine[], inv: { invcNo: number; kind: 'sale' | 'credit_note'; orgInvcNo?: number; trdInvcNo: string; at: Date; customerName?: string | null; customerPhone?: string | null; pmtTyCd: string; tradeName?: string | null; address?: string | null }) {
  const itemList = lines.map((l, n) => {
    const dcAmt = l.supply - l.target;
    const rate = TAX_RATES[l.taxTyCd] ?? 0;
    const tax = rate ? Math.round((l.target * rate) / (100 + rate)) : 0;
    return {
      itemSeq: n + 1, itemCd: (l as SaleLine & { itemCd?: string }).itemCd ?? '', itemClsCd: l.itemClsCd, itemNm: l.name.slice(0, 200), bcd: null,
      pkgUnitCd: 'NT', pkg: l.qty, qtyUnitCd: 'U', qty: l.qty, prc: kes(l.prc), splyAmt: kes(l.supply),
      dcRt: l.supply > 0 ? Math.round((dcAmt / l.supply) * 10000) / 100 : 0, dcAmt: kes(dcAmt),
      isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
      taxTyCd: l.taxTyCd, taxblAmt: kes(l.target), taxAmt: kes(tax), totAmt: kes(l.target),
      _tax: tax,
    };
  });
  const sum = (ty: string, f: 'taxblAmt' | '_tax') => itemList.filter((i) => i.taxTyCd === ty).reduce((a, i) => a + (f === '_tax' ? i._tax : Math.round(i.taxblAmt * 100)), 0);
  const totals: Record<string, number> = {};
  for (const ty of ['A', 'B', 'C', 'D', 'E']) {
    totals[`taxblAmt${ty}`] = kes(sum(ty, 'taxblAmt'));
    totals[`taxRt${ty}`] = TAX_RATES[ty];
    totals[`taxAmt${ty}`] = kes(sum(ty, '_tax'));
  }
  const totTaxbl = lines.reduce((a, l) => a + l.target, 0);
  const totTax = itemList.reduce((a, i) => a + i._tax, 0);
  const at = kraTime(inv.at);
  const credit = inv.kind === 'credit_note';
  return {
    trdInvcNo: inv.trdInvcNo.slice(0, 50), invcNo: inv.invcNo, orgInvcNo: credit ? inv.orgInvcNo ?? 0 : 0,
    custTin: null, custNm: inv.customerName ? inv.customerName.slice(0, 60) : null,
    salesTyCd: 'N', rcptTyCd: credit ? 'R' : 'S', pmtTyCd: inv.pmtTyCd, salesSttsCd: '02',
    cfmDt: at, salesDt: at.slice(0, 8), stockRlsDt: at, cnclReqDt: null, cnclDt: null,
    rfdDt: credit ? at : null, rfdRsnCd: credit ? '06' : null,
    totItemCnt: itemList.length, ...totals, totTaxblAmt: kes(totTaxbl), totTaxAmt: kes(totTax), totAmt: kes(totTaxbl),
    prchrAcptcYn: 'N', remark: null, ...OPERATOR,
    receipt: { custTin: null, custMblNo: inv.customerPhone ? inv.customerPhone.slice(0, 20) : null, rcptPbctDt: at, trdeNm: inv.tradeName ? inv.tradeName.slice(0, 20) : null, adrs: inv.address ? inv.address.slice(0, 200) : null, topMsg: null, btmMsg: null, prchrAcptcYn: 'N' },
    itemList: itemList.map(({ _tax, ...i }) => i),
  };
}

/** Payment method code (KRA code class 07). Mixed payments are reported as "other". */
export function paymentType(methods: string[]) {
  const set = new Set(methods);
  if (set.size !== 1) return set.size ? '07' : '01';
  const m = [...set][0];
  return ({ cash: '01', account: '02', card: '05', mpesa: '06' } as Record<string, string>)[m] ?? '07';
}

// ───────────────────────────── Items ─────────────────────────────

async function ensureItems(h: EtimsHandle, lines: SaleLine[]) {
  const out: Array<SaleLine & { itemCd: string }> = [];
  for (const l of lines) {
    if (!/^\d{1,10}$/.test(l.itemClsCd)) throw new EtimsError(`Set a KRA item classification for "${l.name}" (on the product, or the default under Integrations → KRA eTIMS)`, 'config');
    const hash = crypto.createHash('sha1').update([l.name, l.itemClsCd, l.taxTyCd, l.itemTyCd].join('|')).digest('hex');
    let doc = await EtimsItem.findOne({ tenantId: h.tenantId, series: h.series, key: l.key });
    if (!doc) {
      const c = await EtimsCounter.findOneAndUpdate({ tenantId: h.tenantId, series: h.series }, { $inc: { lastItemSeq: 1 } }, { upsert: true, new: true });
      // KRA's recommended pattern: origin country, product type, packaging unit, quantity unit, running number.
      const itemCd = `KE${l.itemTyCd}NTU${String(c.lastItemSeq).padStart(7, '0')}`;
      doc = (await EtimsItem.findOneAndUpdate({ tenantId: h.tenantId, series: h.series, key: l.key }, { $setOnInsert: { itemCd } }, { upsert: true, new: true }))!;
    }
    if (doc.hash !== hash) {
      await h.client.saveItem({
        itemCd: doc.itemCd, itemClsCd: l.itemClsCd, itemTyCd: l.itemTyCd, itemNm: l.name.slice(0, 200), itemStdNm: null, orgnNatCd: 'KE',
        pkgUnitCd: 'NT', qtyUnitCd: 'U', taxTyCd: l.taxTyCd, btchNo: null, bcd: null, dftPrc: kes(l.prc),
        grpPrcL1: null, grpPrcL2: null, grpPrcL3: null, grpPrcL4: null, grpPrcL5: null, addInfo: null, sftyQty: null,
        isrcAplcbYn: 'N', useYn: 'Y', ...OPERATOR,
      });
      doc.set({ hash, name: l.name, itemClsCd: l.itemClsCd, taxTyCd: l.taxTyCd, registeredAt: new Date() });
      await doc.save();
    }
    out.push({ ...l, itemCd: doc.itemCd });
  }
  return out;
}

// ───────────────────────────── Queue ─────────────────────────────

async function nextInvoiceNo(h: EtimsHandle, session: import('mongoose').ClientSession) {
  const c = await EtimsCounter.findOneAndUpdate({ tenantId: h.tenantId, series: h.series }, { $inc: { lastInvcNo: 1 } }, { new: true, session });
  return c!.lastInvcNo;
}

/** Give new paid sales (oldest first) and new refunds their KRA invoice numbers. */
export async function enqueuePending(h: EtimsHandle) {
  // The counter starts after the last number used with KRA before Chili POS.
  await EtimsCounter.updateOne({ tenantId: h.tenantId, series: h.series }, { $setOnInsert: { lastInvcNo: Number(h.settings.startAfterInvcNo) || 0, lastItemSeq: 0 } }, { upsert: true });
  const orders = await Order.find({ tenantId: h.tenantId, status: 'paid', paidAt: { $gte: h.startFrom }, 'fiscal.queuedAt': { $exists: false } }, { _id: 1, branchId: 1, number: 1, receiptNumber: 1, totals: 1 }).sort({ paidAt: 1, _id: 1 }).limit(200).lean();
  for (const o of orders) {
    await withTransaction(async (session) => {
      // Re-check inside the transaction so two workers never number the same sale.
      const claimed = await Order.updateOne({ tenantId: h.tenantId, _id: o._id, 'fiscal.queuedAt': { $exists: false } }, { $set: { 'fiscal.queuedAt': new Date() } }, { session });
      if (!claimed.modifiedCount) return;
      const invcNo = await nextInvoiceNo(h, session);
      await Order.updateOne({ tenantId: h.tenantId, _id: o._id }, { $set: { 'fiscal.invcNo': invcNo } }, { session });
      await EtimsInvoice.create([{ tenantId: h.tenantId, branchId: o.branchId, series: h.series, invcNo, kind: 'sale', orderId: o._id, orderNumber: o.number, receiptNumber: o.receiptNumber, amount: o.totals?.total ?? 0 }], { session });
    });
  }
  // Credit notes need the sale signed first (they refer to its invoice number).
  const refunds = await Refund.find({ tenantId: h.tenantId, status: 'completed', fiscalQueuedAt: { $exists: false } }).sort({ createdAt: 1 }).limit(100).lean();
  for (const r of refunds) {
    const sale = await EtimsInvoice.findOne({ tenantId: h.tenantId, kind: 'sale', orderId: r.orderId }).lean();
    if (sale && sale.status !== 'signed') continue; // wait for the sale
    await withTransaction(async (session) => {
      const claimed = await Refund.updateOne({ tenantId: h.tenantId, _id: r._id, fiscalQueuedAt: { $exists: false } }, { $set: { fiscalQueuedAt: new Date() } }, { session });
      if (!claimed.modifiedCount || !sale) return; // a sale from before eTIMS was switched on has nothing to credit
      const invcNo = await nextInvoiceNo(h, session);
      await EtimsInvoice.create([{ tenantId: h.tenantId, branchId: r.branchId, series: h.series, invcNo, kind: 'credit_note', orderId: r.orderId, orderNumber: sale.orderNumber, receiptNumber: sale.receiptNumber, refundId: r._id, orgInvcNo: sale.invcNo, amount: r.amount }], { session });
    });
  }
}

/** Build and send one invoice. Updates its status; throws only on programming errors. */
export async function sendInvoice(h: EtimsHandle, invoiceId: Types.ObjectId) {
  const inv = await EtimsInvoice.findOne({ tenantId: h.tenantId, _id: invoiceId });
  if (!inv || inv.status === 'signed') return inv;
  inv.attempts += 1;
  try {
    const [order, tenant, branch, payments] = await Promise.all([
      Order.findOne({ tenantId: h.tenantId, _id: inv.orderId }).lean(),
      Tenant.findById(h.tenantId, { name: 1 }).lean(),
      Branch.findOne({ tenantId: h.tenantId, _id: inv.branchId }, { address: 1 }).lean(),
      Payment.find({ tenantId: h.tenantId, orderId: inv.orderId }, { method: 1, status: 1 }).lean(),
    ]);
    if (!order) throw new EtimsError('The order for this invoice no longer exists', 'rejected');
    let lines = await saleLines(h, order);
    if (inv.kind === 'credit_note') {
      // A partial refund credits each line in proportion; a full refund credits it all.
      const parts = allocate(inv.amount, lines.map((l) => l.target));
      lines = lines.map((l, n) => ({ ...l, target: parts[n] })).filter((l) => l.target > 0);
    }
    const registered = await ensureItems(h, lines);
    const body = saleBody(registered, {
      invcNo: inv.invcNo, kind: inv.kind as 'sale' | 'credit_note', orgInvcNo: inv.orgInvcNo ?? undefined,
      trdInvcNo: inv.kind === 'credit_note' ? `${order.receiptNumber ?? order.number}-R${inv.invcNo}` : order.receiptNumber ?? order.number,
      at: inv.kind === 'credit_note' ? inv.get('createdAt') : order.paidAt ?? new Date(), customerName: order.customerName, customerPhone: order.customerPhone,
      pmtTyCd: paymentType(payments.map((p) => p.method)), tradeName: tenant?.name, address: branch?.address,
    });
    const sig = await h.client.saveSale(body);
    inv.set({
      status: 'signed', result: sig, signedAt: new Date(), lastError: undefined, lastResultCd: '000', simulated: h.client.simulated,
      qrUrl: `${RECEIPT_URLS[h.environment]}?Data=${encodeURIComponent(`${h.tin}${h.bhfId}${sig.rcptSign}`)}`,
    });
  } catch (e) {
    const err = e instanceof EtimsError ? e : new EtimsError((e as Error).message, 'transport');
    inv.lastError = err.message.slice(0, 500);
    inv.lastResultCd = err.resultCd;
    if (err.type === 'transport') {
      // Same number next time; back off up to 30 minutes while KRA (or the internet) is down.
      inv.nextAttemptAt = new Date(Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(inv.attempts - 1, 6)));
    } else if (err.type === 'duplicate') inv.status = 'duplicate';
    else if (err.type === 'config') inv.nextAttemptAt = new Date(Date.now() + 10 * 60_000);
    else inv.status = 'rejected';
  }
  await inv.save();
  return inv;
}

const running = new Set<string>();

/** Send right after a sale or refund (in the background) instead of waiting for the next scheduled run. */
export function kickEtims(tenantId: Types.ObjectId) {
  setImmediate(() => {
    import('./liveSync')
      .then(async ({ isLiveCopy }) => { if (!(await isLiveCopy())) await processEtims(tenantId); })
      .catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'KRA eTIMS: will retry'));
  });
}

/** Number new sales/refunds and send what is due. Called by the scheduler and right after a payment. */
export async function processEtims(only?: Types.ObjectId) {
  const configs = await IntegrationConfiguration.find({ kind: 'etims', enabled: true, branchId: null, ...(only ? { tenantId: only } : {}) }, { tenantId: 1 }).setOptions({ skipTenantGuard: true }).lean();
  for (const c of configs) {
    const key = String(c.tenantId);
    if (running.has(key)) continue;
    running.add(key);
    try {
      const h = await getEtims(c.tenantId as Types.ObjectId);
      if (!h) continue;
      await enqueuePending(h);
      const due = await EtimsInvoice.find({ tenantId: h.tenantId, series: h.series, status: 'queued', nextAttemptAt: { $lte: new Date() } }, { _id: 1 }).sort({ invcNo: 1 }).limit(25).lean();
      for (const d of due) {
        const inv = await sendInvoice(h, d._id);
        if (!inv) continue;
        if (inv.status === 'signed' && inv.attempts > 1) await recordIntegrationResult(h.tenantId, 'etims', { ok: true, action: 'sale', message: `Invoice ${inv.invcNo} signed after ${inv.attempts} attempts`, simulated: h.client.simulated });
        if (inv.status !== 'signed') {
          await recordIntegrationResult(h.tenantId, 'etims', { ok: false, action: inv.kind, message: `Invoice ${inv.invcNo} (${inv.orderNumber}): ${inv.lastError}` });
          if (inv.status === 'queued') break; // KRA unreachable: keep the order, try the rest later
        }
      }
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e, tenantId: key }, 'KRA eTIMS: will retry');
      if (e instanceof EtimsError && e.type === 'config') await recordIntegrationResult(c.tenantId as Types.ObjectId, 'etims', { ok: false, action: 'config', message: e.message }).catch(() => undefined);
    } finally {
      running.delete(key);
    }
  }
}

/** Ask for a resend of a rejected/duplicate invoice (same KRA number) after fixing the cause. */
export async function retryInvoice(tenantId: Types.ObjectId, id: string) {
  return EtimsInvoice.findOneAndUpdate({ tenantId, _id: id, status: { $ne: 'signed' } }, { $set: { status: 'queued', nextAttemptAt: new Date() } }, { new: true });
}

/** What the receipt prints for eTIMS: the signature, or a "pending" note while it is being sent. */
export async function receiptFiscal(tenantId: Types.ObjectId, orderId: Types.ObjectId, paidAt?: Date | null) {
  const cfg = await IntegrationConfiguration.findOne({ tenantId, kind: 'etims', enabled: true, branchId: null }, { settings: 1 }).lean();
  if (!cfg) return null;
  const startFrom = (cfg.settings as EtimsSettings | undefined)?.startFrom;
  if (startFrom && paidAt && paidAt < new Date(startFrom)) return null; // declared before eTIMS was switched on
  const inv = await EtimsInvoice.findOne({ tenantId, kind: 'sale', orderId }).lean();
  if (!inv || inv.status !== 'signed') return { pending: true as const };
  return { pending: false as const, simulated: !!inv.simulated, invcNo: inv.invcNo, ...inv.result, qrUrl: inv.qrUrl };
}
