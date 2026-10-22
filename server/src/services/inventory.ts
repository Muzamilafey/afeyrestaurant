import type { ClientSession, Types } from 'mongoose';
import { Ingredient, StockBalance, StockLedger, StockLot, Recipe, RecipeVersion, Tenant, LEDGER_TYPES } from '../models';
import { round, toBaseQty } from '../lib/units';
import { badRequest, conflict, notFound } from '../lib/errors';

type LedgerType = (typeof LEDGER_TYPES)[number];

export interface MovementInput {
  tenantId: Types.ObjectId;
  branchId: Types.ObjectId;
  ingredientId: Types.ObjectId;
  type: LedgerType;
  /** Signed quantity in base units: positive = stock in, negative = stock out. */
  qty: number;
  /** Cost per base unit (cents) for incoming stock. Ignored for outgoing (FIFO/average decides). */
  unitCost?: number;
  idempotencyKey: string;
  refType?: string;
  refId?: Types.ObjectId;
  refLine?: string;
  reason?: string;
  recipeVersionId?: Types.ObjectId;
  by?: Types.ObjectId;
  batchNo?: string;
  expiresAt?: Date;
  /** Allow the balance to go below zero (sales already served, authorised overrides). */
  allowNegative?: boolean;
}

/**
 * Post one stock movement: append to the ledger, maintain FIFO lots and the cached balance.
 * Idempotent: replaying the same idempotencyKey is a no-op that returns the original entry.
 * Must run inside a transaction so ledger, lots and balance stay consistent.
 */
export async function postMovement(m: MovementInput, session: ClientSession) {
  const existing = await StockLedger.findOne({ tenantId: m.tenantId, idempotencyKey: m.idempotencyKey }).session(session);
  if (existing) return { entry: existing, duplicate: true };
  if (!Number.isFinite(m.qty) || m.qty === 0) throw badRequest('Stock movement quantity must be non-zero');

  const ingredient = await Ingredient.findOne({ tenantId: m.tenantId, _id: m.ingredientId }).session(session);
  if (!ingredient) throw notFound('Ingredient');
  const tenant = await Tenant.findById(m.tenantId).session(session).lean();
  const policy = tenant?.settings?.costingPolicy ?? 'fifo';

  const balance = await StockBalance.findOneAndUpdate(
    { tenantId: m.tenantId, branchId: m.branchId, ingredientId: m.ingredientId },
    { $setOnInsert: { qty: 0, value: 0 } },
    { upsert: true, new: true, session },
  );
  const qty = round(m.qty);
  let unitCost = 0;
  let totalCost = 0;
  const allocations: Array<{ lotId: Types.ObjectId; qty: number; unitCost: number }> = [];

  if (qty > 0) {
    unitCost = m.unitCost ?? (balance.qty > 0 ? balance.value / balance.qty : ingredient.lastCost ?? 0);
    totalCost = qty * unitCost;
    const lot = await StockLot.create(
      [{ tenantId: m.tenantId, branchId: m.branchId, ingredientId: m.ingredientId, qtyReceived: qty, qtyRemaining: qty, unitCost, batchNo: m.batchNo, expiresAt: m.expiresAt, sourceType: m.type, sourceId: m.refId }],
      { session },
    );
    allocations.push({ lotId: lot[0]._id, qty, unitCost });
    if (m.type === 'receipt' && m.unitCost !== undefined) ingredient.lastCost = m.unitCost;
  } else {
    const out = -qty;
    const allowNeg = m.allowNegative || tenant?.settings?.allowNegativeStock;
    if (!allowNeg && balance.qty - out < -1e-9) {
      throw conflict(`Insufficient stock of ${ingredient.name}: have ${round(balance.qty, 2)}${ingredient.baseUnit}, need ${round(out, 2)}${ingredient.baseUnit}`, 'INSUFFICIENT_STOCK', { ingredientId: String(ingredient._id), available: balance.qty, required: out });
    }
    if (policy === 'fifo') {
      // Consume oldest lots first (expiring lots first when expiry is tracked).
      let remaining = out;
      const lots = await StockLot.find({ tenantId: m.tenantId, branchId: m.branchId, ingredientId: m.ingredientId, qtyRemaining: { $gt: 0 } })
        .sort(ingredient.trackExpiry ? { expiresAt: 1, receivedAt: 1 } : { receivedAt: 1 })
        .session(session);
      for (const lot of lots) {
        if (remaining <= 1e-9) break;
        const take = Math.min(lot.qtyRemaining, remaining);
        lot.qtyRemaining = round(lot.qtyRemaining - take);
        await lot.save({ session });
        allocations.push({ lotId: lot._id, qty: take, unitCost: lot.unitCost });
        totalCost += take * lot.unitCost;
        remaining = round(remaining - take);
      }
      // Stock sold beyond recorded lots (negative stock) is costed at the last known cost.
      if (remaining > 1e-9) totalCost += remaining * (ingredient.lastCost ?? 0);
      unitCost = out > 0 ? totalCost / out : 0;
    } else {
      unitCost = balance.qty > 0 ? balance.value / balance.qty : ingredient.lastCost ?? 0;
      totalCost = out * unitCost;
    }
    totalCost = -totalCost;
  }

  balance.qty = round(balance.qty + qty);
  balance.value = round(Math.max(0, balance.value + totalCost), 2);
  if (balance.qty <= 0) balance.value = 0;
  balance.lastMovementAt = new Date();
  await balance.save({ session });
  await ingredient.save({ session });

  const [entry] = await StockLedger.create(
    [{
      tenantId: m.tenantId, branchId: m.branchId, ingredientId: m.ingredientId, type: m.type, qty, unitCost: round(unitCost),
      totalCost: round(totalCost, 2), balanceAfter: balance.qty, refType: m.refType, refId: m.refId, refLine: m.refLine,
      reason: m.reason, recipeVersionId: m.recipeVersionId, lotAllocations: allocations, by: m.by, idempotencyKey: m.idempotencyKey,
    }],
    { session },
  );
  return { entry, duplicate: false };
}

export async function getCurrentRecipeVersion(tenantId: Types.ObjectId, productId: Types.ObjectId, variant = '') {
  const recipe = (await Recipe.findOne({ tenantId, productId, variant, active: true }).lean()) ?? (variant ? await Recipe.findOne({ tenantId, productId, variant: '', active: true }).lean() : null);
  if (!recipe?.currentVersionId) return null;
  return RecipeVersion.findOne({ tenantId, _id: recipe.currentVersionId }).lean();
}

/** Create a new immutable recipe version and make it current. Earlier sales keep their version. */
export async function saveRecipe(
  tenantId: Types.ObjectId,
  input: { productId: Types.ObjectId; variant?: string; yield?: number; notes?: string; lines: Array<{ ingredientId: Types.ObjectId; qty: number; unit?: string }> },
  by: Types.ObjectId,
  session?: ClientSession,
) {
  const ingredients = await Ingredient.find({ tenantId, _id: { $in: input.lines.map((l) => l.ingredientId) } }).session(session ?? null).lean();
  const lines = input.lines.map((l) => {
    const ing = ingredients.find((i) => String(i._id) === String(l.ingredientId));
    if (!ing) throw badRequest(`Unknown ingredient ${l.ingredientId}`);
    return { ingredientId: ing._id, ingredientName: ing.name, qty: l.qty, unit: l.unit ?? ing.baseUnit, baseQty: toBaseQty(l.qty, l.unit, ing) };
  });
  const variant = input.variant ?? '';
  const recipe = await Recipe.findOneAndUpdate({ tenantId, productId: input.productId, variant }, { $inc: { currentVersion: 1 }, $set: { active: true } }, { upsert: true, new: true, session });
  const [version] = await RecipeVersion.create([{ tenantId, recipeId: recipe!._id, productId: input.productId, version: recipe!.currentVersion, yield: input.yield ?? 1, lines, notes: input.notes, createdBy: by }], { session });
  await Recipe.updateOne({ tenantId, _id: recipe!._id }, { $set: { currentVersionId: version._id } }, { session });
  return version;
}

/** Ingredient requirements for selling `qty` units of a recipe version. */
export function requirements(version: { lines: Array<{ ingredientId: Types.ObjectId; baseQty: number }>; yield?: number | null }, qty: number) {
  const y = version.yield && version.yield > 0 ? version.yield : 1;
  return version.lines.map((l) => ({ ingredientId: l.ingredientId, qty: round((l.baseQty * qty) / y) }));
}

/** Check whether the branch has enough stock; returns the shortfalls (empty when sufficient). */
export async function checkAvailability(tenantId: Types.ObjectId, branchId: Types.ObjectId, needs: Array<{ ingredientId: Types.ObjectId; qty: number }>) {
  const agg = new Map<string, number>();
  for (const n of needs) agg.set(String(n.ingredientId), (agg.get(String(n.ingredientId)) ?? 0) + n.qty);
  if (!agg.size) return [];
  const ids = [...agg.keys()];
  const [balances, ingredients] = await Promise.all([
    StockBalance.find({ tenantId, branchId, ingredientId: { $in: ids } }).lean(),
    Ingredient.find({ tenantId, _id: { $in: ids } }, { name: 1, baseUnit: 1 }).lean(),
  ]);
  const short: Array<{ ingredientId: string; name: string; available: number; required: number; unit: string }> = [];
  for (const [id, req] of agg) {
    const have = balances.find((b) => String(b.ingredientId) === id)?.qty ?? 0;
    if (have + 1e-9 < req) {
      const ing = ingredients.find((i) => String(i._id) === id);
      short.push({ ingredientId: id, name: ing?.name ?? id, available: have, required: req, unit: ing?.baseUnit ?? '' });
    }
  }
  return short;
}
