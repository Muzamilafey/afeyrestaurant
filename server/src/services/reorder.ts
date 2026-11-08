import { Types } from 'mongoose';
import { Ingredient, PurchaseOrder, StockBalance, StockLedger, Supplier } from '../models';

/** Stock leaving through sales and losses (sales are negative ledger quantities; reversals put stock back). */
const USAGE_TYPES = ['sale', 'sale_reversal', 'complimentary', 'wastage', 'breakage', 'spoilage'];

export interface ReorderLine {
  ingredientId: string; name: string; unit: string; onHand: number; onOrder: number; dailyUsage: number; daysLeft: number | null;
  minLevel: number; target: number; suggestQty: number; purchaseUnit: { name: string; factor: number; qty: number } | null;
  supplierId: string | null; supplierName: string | null; estimatedCost: number; reason: string;
}

/**
 * What to buy: for each ingredient, average daily usage over the last `days`, stock on hand and already on order.
 * Reorder when what you will have can't cover the lead time (or falls under the minimum level); buy enough to
 * reach the maximum level, or `coverDays` of usage, rounded to the reorder quantity / purchase unit.
 */
export async function reorderSuggestions(tenantId: Types.ObjectId, branchId: Types.ObjectId, opts: { days?: number; coverDays?: number; leadDays?: number } = {}) {
  const days = opts.days ?? 14;
  const coverDays = opts.coverDays ?? 7;
  const leadDays = opts.leadDays ?? 2;
  const since = new Date(Date.now() - days * 86400_000);
  const [ings, bals, usage, openPos, suppliers] = await Promise.all([
    Ingredient.find({ tenantId, active: true }).lean(),
    StockBalance.find({ tenantId, branchId }).lean(),
    StockLedger.aggregate([{ $match: { tenantId, branchId, type: { $in: USAGE_TYPES }, createdAt: { $gte: since } } }, { $group: { _id: '$ingredientId', qty: { $sum: '$qty' } } }]),
    PurchaseOrder.find({ tenantId, branchId, status: { $in: ['submitted', 'approved', 'partially_received'] } }).lean(),
    Supplier.find({ tenantId }).select('name').lean(),
  ]);
  const onOrder = new Map<string, number>();
  for (const po of openPos) for (const l of po.lines) {
    const k = String(l.ingredientId);
    onOrder.set(k, (onOrder.get(k) ?? 0) + Math.max(0, ((l.qty ?? 0) - (l.receivedQty ?? 0)) * (l.unitFactor ?? 1)));
  }
  const out: ReorderLine[] = [];
  for (const i of ings) {
    const k = String(i._id);
    const onHand = bals.find((b) => String(b.ingredientId) === k)?.qty ?? 0;
    const used = -(usage.find((u) => String(u._id) === k)?.qty ?? 0);
    const daily = Math.max(0, used / days);
    const incoming = onOrder.get(k) ?? 0;
    const min = i.minLevel ?? 0;
    if (!daily && !min) continue; // never used and no minimum: nothing to say
    const reorderPoint = Math.max(min, daily * leadDays);
    const projected = onHand + incoming;
    if (projected > reorderPoint) continue;
    const target = i.maxLevel && i.maxLevel > 0 ? i.maxLevel : Math.max(min * 2, daily * (coverDays + leadDays));
    let qty = Math.max(0, target - projected);
    if (i.reorderQty && i.reorderQty > 0) qty = Math.ceil(qty / i.reorderQty) * i.reorderQty;
    if (qty <= 0) continue;
    // Express it in the biggest named unit that fits (crate, bottle, sack), rounded up.
    const unit = [...(i.units ?? [])].filter((u) => (u.factor ?? 0) > 0 && (u.factor ?? 0) <= qty).sort((a, b) => (b.factor ?? 0) - (a.factor ?? 0))[0];
    const purchaseUnit = unit ? { name: unit.name ?? 'unit', factor: unit.factor!, qty: Math.ceil(qty / unit.factor!) } : null;
    if (purchaseUnit) qty = purchaseUnit.qty * purchaseUnit.factor;
    const supplier = i.preferredSupplierId ? suppliers.find((s) => String(s._id) === String(i.preferredSupplierId)) : null;
    out.push({
      ingredientId: k, name: i.name, unit: i.baseUnit, onHand, onOrder: incoming, dailyUsage: Math.round(daily * 100) / 100,
      daysLeft: daily > 0 ? Math.round((onHand / daily) * 10) / 10 : null, minLevel: min, target: Math.round(target), suggestQty: Math.round(qty * 100) / 100,
      purchaseUnit, supplierId: supplier ? String(supplier._id) : null, supplierName: supplier?.name ?? null, estimatedCost: Math.round(qty * (i.lastCost ?? 0)),
      reason: onHand <= 0 ? 'Out of stock' : projected <= min && min > 0 ? 'Below minimum level' : `About ${Math.max(0, Math.round((projected / Math.max(daily, 0.0001)) * 10) / 10)} days left`,
    });
  }
  out.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  return { days, coverDays, leadDays, items: out, estimatedTotal: out.reduce((a, l) => a + l.estimatedCost, 0) };
}
