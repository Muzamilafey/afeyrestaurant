import type { Types } from 'mongoose';
import { bpsOf, inclusiveTax } from '../lib/money';

export interface TaxDef { _id: Types.ObjectId; code: string; rateBps: number; inclusive: boolean }

/** Local time parts in the tenant's timezone. */
export function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return { day: dayIdx, time: `${hh}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

export function inWindow(time: string, start?: string | null, end?: string | null) {
  if (!start || !end) return true;
  return start <= end ? time >= start && time < end : time >= start || time < end; // overnight windows
}

export interface PricableProduct {
  _id: Types.ObjectId;
  price: number;
  categoryId: Types.ObjectId;
  branchPrices?: Array<{ branchId?: Types.ObjectId | null; price?: number | null }>;
  happyHourPrice?: number | null;
  variants?: Array<{ name?: string | null; price?: number | null }>;
}

export interface HappyHour { days?: number[]; start?: string | null; end?: string | null; discountBps?: number | null; categoryIds?: Types.ObjectId[] }

/** Resolve the base unit price: variant → branch override → happy hour. */
export function resolvePrice(p: PricableProduct, opts: { branchId: Types.ObjectId; variant?: string; happyHours?: HappyHour[]; now: { day: number; time: string } }) {
  let price = p.price;
  let variantName: string | undefined;
  if (opts.variant) {
    const v = p.variants?.find((x) => x.name === opts.variant);
    if (!v) return { error: `Unknown size/variant "${opts.variant}"` } as const;
    price = v.price ?? price;
    variantName = v.name ?? undefined;
  } else {
    const bp = p.branchPrices?.find((b) => String(b.branchId) === String(opts.branchId));
    if (bp?.price != null) price = bp.price;
  }
  let happyHour = false;
  const hh = (opts.happyHours ?? []).find(
    (h) => (!h.days?.length || h.days.includes(opts.now.day)) && inWindow(opts.now.time, h.start, h.end) && (!h.categoryIds?.length || h.categoryIds.some((c) => String(c) === String(p.categoryId))),
  );
  if (hh) {
    happyHour = true;
    if (p.happyHourPrice != null && !opts.variant) price = p.happyHourPrice;
    else if (hh.discountBps) price = price - bpsOf(price, hh.discountBps);
  }
  return { price, variantName, happyHour } as const;
}

export interface TotalsInput {
  items: Array<{ qty: number; unitPrice: number; discount?: number | null; voided?: boolean | null; complimentary?: boolean | null; serviceChargeApplies?: boolean | null; taxRateIds?: Types.ObjectId[] }>;
  orderDiscount: { type: 'percent' | 'amount' | 'none'; value: number };
  serviceChargeBps: number;
  serviceChargeEligible: boolean;
  deliveryFee: number;
  taxes: TaxDef[];
}

/**
 * Compute order totals in integer cents.
 * - Line total = qty × unit price − line discount (0 for voided/complimentary lines).
 * - Order discount is allocated across lines pro rata for tax purposes.
 * - Inclusive taxes are extracted from the price; exclusive taxes are added on top.
 * - Service charge applies to eligible lines after discount and is not itself taxed.
 */
export function computeTotals(input: TotalsInput) {
  const lines = input.items.map((it) => {
    const gross = it.voided || it.complimentary ? 0 : Math.max(0, Math.round(it.qty * it.unitPrice) - (it.discount ?? 0));
    return { ...it, lineTotal: gross };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  let discount = 0;
  if (input.orderDiscount.type === 'percent') discount = bpsOf(subtotal, Math.round(input.orderDiscount.value * 100));
  else if (input.orderDiscount.type === 'amount') discount = Math.min(subtotal, Math.round(input.orderDiscount.value));
  discount = Math.min(discount, subtotal);

  let allocated = 0;
  const taxByCode = new Map<string, { code: string; rateBps: number; inclusive: boolean; amount: number }>();
  let serviceBase = 0;
  const lineTaxes = lines.map((l, idx) => {
    // Allocate the discount; the last non-zero line absorbs rounding.
    let share = subtotal > 0 ? Math.round((discount * l.lineTotal) / subtotal) : 0;
    if (idx === lines.length - 1) share = discount - allocated;
    allocated += share;
    const net = Math.max(0, l.lineTotal - share);
    if (l.serviceChargeApplies !== false) serviceBase += net;
    const taxes = (l.taxRateIds ?? [])
      .map((id) => input.taxes.find((t) => String(t._id) === String(id)))
      .filter((t): t is TaxDef => !!t)
      .map((t) => {
        const amount = t.inclusive ? inclusiveTax(net, t.rateBps) : bpsOf(net, t.rateBps);
        const agg = taxByCode.get(t.code) ?? { code: t.code, rateBps: t.rateBps, inclusive: t.inclusive, amount: 0 };
        agg.amount += amount;
        taxByCode.set(t.code, agg);
        return { code: t.code, rateBps: t.rateBps, inclusive: t.inclusive, amount };
      });
    return { lineTotal: l.lineTotal, taxes };
  });
  const breakdown = [...taxByCode.values()];
  const taxInclusive = breakdown.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0);
  const taxExclusive = breakdown.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0);
  const serviceCharge = input.serviceChargeEligible ? bpsOf(serviceBase, input.serviceChargeBps) : 0;
  const total = subtotal - discount + serviceCharge + taxExclusive + input.deliveryFee;
  return { lines: lineTaxes, subtotal, discount, serviceCharge, taxInclusive, taxExclusive, deliveryFee: input.deliveryFee, total, breakdown };
}
