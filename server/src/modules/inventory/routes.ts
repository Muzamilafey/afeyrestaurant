import { z } from 'zod';
import { reorderSuggestions } from '../../services/reorder';
import { Types } from 'mongoose';
import { createModule, zId, zMoney } from '../../http/route';
import { Ingredient, StockBalance, StockLedger, StockAdjustment, StockCount, StockTransfer, Recipe, RecipeVersion, Supplier, PurchaseOrder, GoodsReceivedNote, SupplierInvoice, SupplierReturn, Branch, StockLot } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { postMovement, saveRecipe } from '../../services/inventory';
import { withTransaction } from '../../db/connect';
import { audit } from '../../services/audit';
import { notify } from '../../services/notify';
import { nextNumber } from '../../services/counters';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { toBaseQty, round } from '../../lib/units';

const m = createModule('/inventory', 'Inventory & Procurement');

// ── Ingredients ──
const zIngredient = z.object({
  name: z.string().min(1).max(80), sku: z.string().max(40).optional(), kind: z.enum(['raw', 'finished', 'packaged_beverage', 'spirit', 'beer', 'wine', 'mixer', 'packaging', 'other']),
  baseUnit: z.enum(['g', 'ml', 'pcs']), units: z.array(z.object({ name: z.string().min(1).max(20), factor: z.number().positive() })).max(10).optional(),
  containerSize: z.number().positive().optional(), isBarItem: z.boolean().optional(), trackExpiry: z.boolean().optional(),
  minLevel: z.number().min(0).optional(), maxLevel: z.number().min(0).optional(), reorderQty: z.number().min(0).optional(), lastCost: z.number().min(0).optional(), preferredSupplierId: zId.optional(), active: z.boolean().optional(),
});
m.route({ method: 'get', path: '/ingredients', summary: 'Ingredients with branch stock levels', permission: P.INVENTORY_VIEW }, async ({ ctx }) => {
  const [ings, bals] = await Promise.all([Ingredient.find({ tenantId: ctx.tenantId }).sort({ name: 1 }).lean(), StockBalance.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean()]);
  return ings.map((i) => {
    const b = bals.find((x) => String(x.ingredientId) === String(i._id));
    const qty = b?.qty ?? 0;
    return { ...i, qty, value: b?.value ?? 0, status: qty <= 0 ? 'out' : qty <= (i.minLevel ?? 0) ? 'low' : 'ok', containers: i.containerSize ? round(qty / i.containerSize, 2) : null };
  });
});
m.route({ method: 'post', path: '/ingredients', summary: 'Create ingredient', permission: P.INVENTORY_MANAGE, body: zIngredient, status: 201 }, async ({ ctx, body }) => Ingredient.create({ ...body, tenantId: ctx.tenantId }));
m.route({ method: 'patch', path: '/ingredients/:id', summary: 'Update ingredient', permission: P.INVENTORY_MANAGE, body: zIngredient.partial() }, async ({ ctx, params, body }) => {
  const i = await Ingredient.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!i) throw notFound('Ingredient');
  if (body.baseUnit && body.baseUnit !== i.baseUnit && (await StockLedger.exists({ tenantId: ctx.tenantId, ingredientId: i._id }))) throw conflict('Base unit cannot change once stock movements exist');
  i.set(body);
  await i.save();
  return i;
});
m.route({ method: 'get', path: '/ledger', summary: 'Stock movement ledger', permission: P.INVENTORY_VIEW, query: z.object({ ingredientId: zId.optional(), type: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId, branchId: ctx.branchId };
  if (query.ingredientId) f.ingredientId = query.ingredientId;
  if (query.type) f.type = query.type;
  return StockLedger.find(f).sort({ createdAt: -1 }).limit(query.limit).lean();
});
m.route({ method: 'get', path: '/expiring', summary: 'Lots expiring within N days', permission: P.INVENTORY_VIEW, query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }) }, async ({ ctx, query }) =>
  StockLot.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, qtyRemaining: { $gt: 0 }, expiresAt: { $lte: new Date(Date.now() + query.days * 86400_000) } }).sort({ expiresAt: 1 }).lean(),
);

// ── Opening stock (once per ingredient/branch) ──
m.route({ method: 'post', path: '/opening', summary: 'Record opening stock', permission: P.INVENTORY_ADJUST_APPROVE, body: z.object({ lines: z.array(z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().optional(), unitCost: z.number().min(0) })).min(1).max(500) }) }, async ({ ctx, body, req }) => {
  await withTransaction(async (session) => {
    for (const l of body.lines) {
      const ing = await Ingredient.findOne({ tenantId: ctx.tenantId, _id: l.ingredientId }).session(session).lean();
      if (!ing) throw notFound('Ingredient');
      const base = toBaseQty(l.qty, l.unit, ing);
      await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: ing._id, type: 'opening', qty: base, unitCost: l.unitCost / (base / l.qty), idempotencyKey: `opening:${ctx.branchId}:${ing._id}`, by: ctx.userId, reason: 'Opening stock' }, session);
    }
  });
  await audit(ctx, { action: 'inventory.opening', meta: { lines: body.lines.length } }, req);
  return { ok: true };
});

// ── Adjustments with approval ──
m.route(
  { method: 'post', path: '/adjustments', summary: 'Request a stock adjustment / wastage / breakage (approval required)', permission: P.INVENTORY_ADJUST, status: 201, body: z.object({ type: z.enum(['adjustment', 'wastage', 'breakage', 'spoilage', 'complimentary']), reason: z.string().min(3).max(300), lines: z.array(z.object({ ingredientId: zId, qty: z.number().refine((v) => v !== 0), unit: z.string().optional(), note: z.string().max(200).optional() })).min(1).max(100) }) },
  async ({ ctx, body }) => {
    const ings = await Ingredient.find({ tenantId: ctx.tenantId, _id: { $in: body.lines.map((l) => l.ingredientId) } }).lean();
    const lines = body.lines.map((l) => {
      const ing = ings.find((i) => String(i._id) === l.ingredientId);
      if (!ing) throw notFound('Ingredient');
      if (body.type !== 'adjustment' && l.qty > 0) throw badRequest('Wastage-type movements must be negative (stock out)');
      return { ...l, baseQty: Math.sign(l.qty) * toBaseQty(Math.abs(l.qty), l.unit, ing) };
    });
    return StockAdjustment.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, type: body.type, reason: body.reason, lines, requestedBy: ctx.userId });
  },
);
m.route({ method: 'get', path: '/adjustments', summary: 'List adjustments', permission: P.INVENTORY_VIEW, query: z.object({ status: z.string().optional() }) }, async ({ ctx, query }) => StockAdjustment.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, ...(query.status ? { status: query.status } : {}) }).sort({ createdAt: -1 }).limit(200).lean());
m.route({ method: 'post', path: '/adjustments/:id/decision', summary: 'Approve or reject an adjustment', permission: P.INVENTORY_ADJUST_APPROVE, body: z.object({ approve: z.boolean(), reason: z.string().max(300).optional() }) }, async ({ ctx, params, body, req }) => {
  const adj = await StockAdjustment.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!adj) throw notFound('Adjustment');
  if (adj.status !== 'pending') throw conflict('Adjustment already decided');
  if (String(adj.requestedBy) === String(ctx.userId) && ctx.roleKey !== 'owner') throw forbidden('Adjustments must be approved by someone other than the requester');
  if (!body.approve) {
    adj.set({ status: 'rejected', approvedBy: ctx.userId, approvedAt: new Date(), rejectionReason: body.reason });
    await adj.save();
    return adj;
  }
  await withTransaction(async (session) => {
    for (const [i, l] of adj.lines.entries()) {
      await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: l.ingredientId as Types.ObjectId, type: adj.type as 'adjustment', qty: l.baseQty!, idempotencyKey: `adj:${adj._id}:${i}`, refType: 'StockAdjustment', refId: adj._id, reason: adj.reason, by: ctx.userId }, session);
    }
    adj.set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() });
    await adj.save({ session });
  });
  await audit(ctx, { action: `inventory.${adj.type}`, entity: 'StockAdjustment', entityId: adj._id, reason: adj.reason, approvedBy: ctx.userId, meta: { lines: adj.lines } }, req);
  return adj;
});

// ── Physical stock counts ──
m.route({ method: 'post', path: '/counts', summary: 'Start a stock count (snapshots expected quantities)', permission: P.INVENTORY_MANAGE, body: z.object({ name: z.string().max(80).optional(), ingredientIds: z.array(zId).optional() }), status: 201 }, async ({ ctx, body }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId, active: true };
  if (body.ingredientIds?.length) f._id = { $in: body.ingredientIds };
  const [ings, bals] = await Promise.all([Ingredient.find(f).lean(), StockBalance.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean()]);
  return StockCount.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, name: body.name ?? `Count ${new Date().toISOString().slice(0, 10)}`, countedBy: ctx.userId, lines: ings.map((i) => ({ ingredientId: i._id, ingredientName: i.name, expectedQty: bals.find((b) => String(b.ingredientId) === String(i._id))?.qty ?? 0 })) });
});
m.route({ method: 'get', path: '/counts', summary: 'List stock counts', permission: P.INVENTORY_VIEW }, async ({ ctx }) => StockCount.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ createdAt: -1 }).limit(50).lean());
m.route({ method: 'put', path: '/counts/:id', summary: 'Enter counted quantities', permission: P.INVENTORY_MANAGE, body: z.object({ lines: z.array(z.object({ ingredientId: zId, countedQty: z.number().min(0) })) }) }, async ({ ctx, params, body }) => {
  const c = await StockCount.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!c) throw notFound('Stock count');
  if (c.status === 'posted') throw conflict('Count already posted');
  for (const l of body.lines) {
    const line = c.lines.find((x) => String(x.ingredientId) === l.ingredientId);
    if (line) {
      line.countedQty = l.countedQty;
      line.variance = round(l.countedQty - (line.expectedQty ?? 0));
    }
  }
  c.status = 'submitted';
  await c.save();
  return c;
});
m.route({ method: 'post', path: '/counts/:id/post', summary: 'Post count variances to the ledger (approval)', permission: P.INVENTORY_ADJUST_APPROVE }, async ({ ctx, params, req }) => {
  const c = await StockCount.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!c) throw notFound('Stock count');
  if (c.status !== 'submitted') throw conflict('Submit counted quantities first');
  await withTransaction(async (session) => {
    for (const l of c.lines) {
      if (l.countedQty == null || !l.variance) continue;
      // Variance is applied relative to the balance *now*, so sales since the count started are not overwritten.
      await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: l.ingredientId as Types.ObjectId, type: 'count_variance', qty: l.variance, idempotencyKey: `count:${c._id}:${l.ingredientId}`, refType: 'StockCount', refId: c._id, by: ctx.userId, reason: 'Physical count variance', allowNegative: true }, session);
    }
    c.set({ status: 'posted', postedBy: ctx.userId, postedAt: new Date() });
    await c.save({ session });
  });
  await audit(ctx, { action: 'inventory.count_posted', entity: 'StockCount', entityId: c._id, meta: { variances: c.lines.filter((l) => l.variance).length } }, req);
  return c;
});

// ── Transfers between branches ──
m.route({ method: 'post', path: '/transfers', summary: 'Dispatch stock to another branch', permission: P.INVENTORY_MANAGE, status: 201, body: z.object({ toBranchId: zId, lines: z.array(z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().optional() })).min(1), notes: z.string().max(300).optional() }) }, async ({ ctx, body, req }) => {
  if (body.toBranchId === String(ctx.branchId)) throw badRequest('Choose a different destination branch');
  if (!(await Branch.exists({ tenantId: ctx.tenantId, _id: body.toBranchId }))) throw notFound('Branch');
  const number = await nextNumber(ctx.tenantId, 'TRF', 'ALL');
  const tr = await withTransaction(async (session) => {
    const lines = [];
    for (const l of body.lines) {
      const ing = await Ingredient.findOne({ tenantId: ctx.tenantId, _id: l.ingredientId }).session(session).lean();
      if (!ing) throw notFound('Ingredient');
      lines.push({ ingredientId: ing._id, qty: toBaseQty(l.qty, l.unit, ing) });
    }
    const [doc] = await StockTransfer.create([{ tenantId: ctx.tenantId, fromBranchId: ctx.branchId, toBranchId: body.toBranchId, number, lines, status: 'dispatched', dispatchedBy: ctx.userId, notes: body.notes }], { session });
    for (const l of lines) await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: l.ingredientId, type: 'transfer_out', qty: -l.qty, idempotencyKey: `trf-out:${doc._id}:${l.ingredientId}`, refType: 'StockTransfer', refId: doc._id, by: ctx.userId }, session);
    return doc;
  });
  await audit(ctx, { action: 'inventory.transfer_dispatched', entity: 'StockTransfer', entityId: tr._id }, req);
  return tr;
});
m.route({ method: 'get', path: '/transfers', summary: 'Transfers in/out of this branch', permission: P.INVENTORY_VIEW }, async ({ ctx }) => StockTransfer.find({ tenantId: ctx.tenantId, $or: [{ fromBranchId: ctx.branchId }, { toBranchId: ctx.branchId }] }).sort({ createdAt: -1 }).limit(100).lean());
m.route({ method: 'post', path: '/transfers/:id/receive', summary: 'Receive a transfer at the destination branch', permission: P.INVENTORY_MANAGE }, async ({ ctx, params, req }) => {
  const tr = await StockTransfer.findOne({ tenantId: ctx.tenantId, toBranchId: ctx.branchId, _id: params.id });
  if (!tr) throw notFound('Transfer');
  if (tr.status !== 'dispatched') throw conflict('Transfer is not awaiting receipt');
  await withTransaction(async (session) => {
    for (const l of tr.lines) {
      // Carry the dispatching branch's cost across.
      const out = await StockLedger.findOne({ tenantId: ctx.tenantId, idempotencyKey: `trf-out:${tr._id}:${l.ingredientId}` }).session(session).lean();
      await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: l.ingredientId as Types.ObjectId, type: 'transfer_in', qty: l.qty!, unitCost: out?.unitCost, idempotencyKey: `trf-in:${tr._id}:${l.ingredientId}`, refType: 'StockTransfer', refId: tr._id, by: ctx.userId }, session);
    }
    tr.set({ status: 'received', receivedBy: ctx.userId });
    await tr.save({ session });
  });
  await audit(ctx, { action: 'inventory.transfer_received', entity: 'StockTransfer', entityId: tr._id }, req);
  return tr;
});

// ── Recipes ──
m.route({ method: 'get', path: '/recipes', summary: 'Recipes with current version', permission: [P.INVENTORY_VIEW, P.RECIPES_MANAGE] }, async ({ ctx }) => {
  const recipes = await Recipe.find({ tenantId: ctx.tenantId }).lean();
  const versions = await RecipeVersion.find({ tenantId: ctx.tenantId, _id: { $in: recipes.map((r) => r.currentVersionId).filter(Boolean) } }).lean();
  return recipes.map((r) => ({ ...r, current: versions.find((v) => String(v._id) === String(r.currentVersionId)) ?? null }));
});
m.route({ method: 'get', path: '/recipes/:productId/versions', summary: 'Recipe version history', permission: P.RECIPES_MANAGE }, async ({ ctx, params }) => RecipeVersion.find({ tenantId: ctx.tenantId, productId: params.productId }).sort({ version: -1 }).lean());
m.route({ method: 'put', path: '/recipes/:productId', summary: 'Save a new recipe version', permission: P.RECIPES_MANAGE, body: z.object({ variant: z.string().max(40).optional(), yield: z.number().positive().optional(), notes: z.string().max(500).optional(), lines: z.array(z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().max(20).optional() })).min(1).max(50) }) }, async ({ ctx, params, body, req }) => {
  const v = await saveRecipe(ctx.tenantId, { ...body, productId: new Types.ObjectId(params.productId), lines: body.lines.map((l) => ({ ...l, ingredientId: new Types.ObjectId(l.ingredientId) })) }, ctx.userId);
  await audit(ctx, { action: 'recipe.version_saved', entity: 'Product', entityId: params.productId, meta: { version: v.version } }, req);
  return v;
});

// ── Suppliers ──
const zSupplier = z.object({ name: z.string().min(2).max(100), contactName: z.string().max(80).optional(), phone: z.string().max(20).optional(), email: z.email().optional(), kraPin: z.string().max(20).optional(), address: z.string().max(200).optional(), paymentTermsDays: z.number().int().min(0).max(180).optional(), active: z.boolean().optional() });
m.route({ method: 'get', path: '/suppliers', summary: 'List suppliers with balances', permission: P.PROCUREMENT_VIEW }, async ({ ctx }) => Supplier.find({ tenantId: ctx.tenantId }).sort({ name: 1 }).lean());
m.route({ method: 'post', path: '/suppliers', summary: 'Create supplier', permission: P.PROCUREMENT_MANAGE, body: zSupplier, status: 201 }, async ({ ctx, body }) => Supplier.create({ ...body, tenantId: ctx.tenantId }));
m.route({ method: 'patch', path: '/suppliers/:id', summary: 'Update supplier', permission: P.PROCUREMENT_MANAGE, body: zSupplier.partial() }, async ({ ctx, params, body }) => {
  const s = await Supplier.findOneAndUpdate({ tenantId: ctx.tenantId, _id: params.id }, { $set: body }, { new: true });
  if (!s) throw notFound('Supplier');
  return s;
});

// ── Purchase orders ──
const zPoLine = z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().max(20).optional(), unitPrice: zMoney });
m.route({ method: 'get', path: '/purchase-orders', summary: 'List purchase orders', permission: P.PROCUREMENT_VIEW }, async ({ ctx }) => PurchaseOrder.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ createdAt: -1 }).limit(200).lean());
m.route({ method: 'post', path: '/purchase-orders', summary: 'Create a purchase order', permission: P.PROCUREMENT_MANAGE, status: 201, body: z.object({ supplierId: zId, lines: z.array(zPoLine).min(1).max(100), expectedAt: z.coerce.date().optional(), notes: z.string().max(500).optional() }) }, async ({ ctx, body }) => {
  if (!(await Supplier.exists({ tenantId: ctx.tenantId, _id: body.supplierId }))) throw notFound('Supplier');
  const ings = await Ingredient.find({ tenantId: ctx.tenantId, _id: { $in: body.lines.map((l) => l.ingredientId) } }).lean();
  const lines = body.lines.map((l) => {
    const ing = ings.find((i) => String(i._id) === l.ingredientId);
    if (!ing) throw notFound('Ingredient');
    return { ...l, ingredientName: ing.name, unit: l.unit ?? ing.baseUnit, unitFactor: toBaseQty(1, l.unit, ing) };
  });
  const number = await nextNumber(ctx.tenantId, 'PO', 'ALL');
  return PurchaseOrder.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, supplierId: body.supplierId, number, lines, total: lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0), expectedAt: body.expectedAt, notes: body.notes, createdBy: ctx.userId });
});
m.route({
  method: 'get', path: '/reorder-suggestions', summary: 'What to buy: usage, stock on hand and on order, suggested quantities', permission: [P.PROCUREMENT_VIEW, P.INVENTORY_VIEW],
  query: z.object({ days: z.coerce.number().int().min(3).max(90).optional(), coverDays: z.coerce.number().int().min(1).max(60).optional(), leadDays: z.coerce.number().int().min(0).max(30).optional() }),
}, async ({ ctx, query }) => reorderSuggestions(ctx.tenantId as Types.ObjectId, ctx.branchId as Types.ObjectId, query));

/** Turn chosen suggestions into a draft purchase order for one supplier (priced from the last cost, editable after). */
m.route({
  method: 'post', path: '/reorder-suggestions/purchase-order', summary: 'Create a draft PO from reorder suggestions', permission: P.PROCUREMENT_MANAGE, status: 201,
  body: z.object({ supplierId: zId, lines: z.array(z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().max(20).optional() })).min(1).max(100), notes: z.string().max(500).optional() }),
}, async ({ ctx, body, req }) => {
  if (!(await Supplier.exists({ tenantId: ctx.tenantId, _id: body.supplierId }))) throw notFound('Supplier');
  const ings = await Ingredient.find({ tenantId: ctx.tenantId, _id: { $in: body.lines.map((l) => l.ingredientId) } }).lean();
  const lines = body.lines.map((l) => {
    const ing = ings.find((i) => String(i._id) === l.ingredientId);
    if (!ing) throw notFound('Ingredient');
    const unitFactor = toBaseQty(1, l.unit, ing);
    return { ingredientId: l.ingredientId, ingredientName: ing.name, qty: l.qty, unit: l.unit ?? ing.baseUnit, unitFactor, unitPrice: Math.round((ing.lastCost ?? 0) * unitFactor) };
  });
  const number = await nextNumber(ctx.tenantId, 'PO', 'ALL');
  const po = await PurchaseOrder.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, supplierId: body.supplierId, number, lines, total: lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0), notes: body.notes ?? 'From reorder suggestions', createdBy: ctx.userId });
  await audit(ctx, { action: 'procurement.po_from_suggestions', entity: 'PurchaseOrder', entityId: po._id, meta: { lines: lines.length } }, req);
  return po;
});
m.route({ method: 'post', path: '/purchase-orders/:id/status', summary: 'Submit, approve or cancel a PO', permission: P.PROCUREMENT_MANAGE, body: z.object({ status: z.enum(['submitted', 'approved', 'cancelled']), email: z.boolean().optional() }) }, async ({ ctx, params, body, req }) => {
  const po = await PurchaseOrder.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!po) throw notFound('Purchase order');
  const allowed: Record<string, string[]> = { draft: ['submitted', 'cancelled'], submitted: ['approved', 'cancelled'], approved: ['cancelled'] };
  if (!allowed[po.status]?.includes(body.status)) throw conflict(`Cannot move a ${po.status} PO to ${body.status}`);
  if (body.status === 'approved') {
    if (!ctx.permissions.has(P.PROCUREMENT_APPROVE)) throw forbidden('Missing permission: procurement.approve');
    po.approvedBy = ctx.userId;
  }
  po.status = body.status;
  await po.save();
  await audit(ctx, { action: `procurement.po_${body.status}`, entity: 'PurchaseOrder', entityId: po._id }, req);
  if (body.status === 'approved' && body.email) {
    const sup = await Supplier.findOne({ tenantId: ctx.tenantId, _id: po.supplierId }).lean();
    if (sup?.email) {
      await notify(ctx.tenantId, { event: 'purchase_order', channel: 'email', to: sup.email, vars: { supplier_name: sup.name, po_number: po.number, expected_date: po.expectedAt?.toISOString().slice(0, 10) ?? 'ASAP', lines: po.lines.map((l) => `- ${l.qty} ${l.unit} ${l.ingredientName} @ KSh ${((l.unitPrice ?? 0) / 100).toFixed(2)}`).join('\n') }, dedupeKey: `po:${po._id}` });
      po.emailedAt = new Date();
      await po.save();
    }
  }
  return po;
});

// ── Goods received ──
m.route(
  { method: 'post', path: '/grn', summary: 'Receive goods (against a PO or direct) — posts stock and FIFO lots', permission: P.INVENTORY_MANAGE, status: 201, body: z.object({ supplierId: zId, purchaseOrderId: zId.optional(), supplierInvoiceNo: z.string().max(40).optional(), invoiceDueDate: z.coerce.date().optional(), lines: z.array(zPoLine.extend({ batchNo: z.string().max(40).optional(), expiresAt: z.coerce.date().optional() })).min(1).max(100) }) },
  async ({ ctx, body, req }) => {
    const supplier = await Supplier.findOne({ tenantId: ctx.tenantId, _id: body.supplierId }).lean();
    if (!supplier) throw notFound('Supplier');
    const number = await nextNumber(ctx.tenantId, 'GRN', 'ALL');
    const grn = await withTransaction(async (session) => {
      const po = body.purchaseOrderId ? await PurchaseOrder.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.purchaseOrderId }).session(session) : null;
      if (body.purchaseOrderId && (!po || !['approved', 'partially_received'].includes(po.status))) throw conflict('Purchase order must be approved before receiving');
      const lines = [];
      for (const l of body.lines) {
        const ing = await Ingredient.findOne({ tenantId: ctx.tenantId, _id: l.ingredientId }).session(session).lean();
        if (!ing) throw notFound('Ingredient');
        const factor = toBaseQty(1, l.unit, ing);
        lines.push({ ...l, ingredientName: ing.name, unit: l.unit ?? ing.baseUnit, unitFactor: factor, baseQty: round(l.qty * factor) });
      }
      const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0);
      const [doc] = await GoodsReceivedNote.create([{ tenantId: ctx.tenantId, branchId: ctx.branchId, supplierId: supplier._id, purchaseOrderId: po?._id, number, supplierInvoiceNo: body.supplierInvoiceNo, lines, total, receivedBy: ctx.userId }], { session });
      for (const [i, l] of lines.entries()) {
        await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: new Types.ObjectId(l.ingredientId), type: 'receipt', qty: l.baseQty, unitCost: l.unitPrice / l.unitFactor, idempotencyKey: `grn:${doc._id}:${i}`, refType: 'GoodsReceivedNote', refId: doc._id, by: ctx.userId, batchNo: l.batchNo, expiresAt: l.expiresAt }, session);
        if (po) {
          const pl = po.lines.find((x) => String(x.ingredientId) === l.ingredientId);
          if (pl) pl.receivedQty = (pl.receivedQty ?? 0) + l.qty;
        }
      }
      if (po) {
        po.status = po.lines.every((x) => (x.receivedQty ?? 0) >= (x.qty ?? 0)) ? 'received' : 'partially_received';
        await po.save({ session });
      }
      await Supplier.updateOne({ tenantId: ctx.tenantId, _id: supplier._id }, { $inc: { balance: total } }, { session });
      if (body.supplierInvoiceNo) {
        await SupplierInvoice.create([{ tenantId: ctx.tenantId, supplierId: supplier._id, grnId: doc._id, invoiceNo: body.supplierInvoiceNo, amount: total, dueDate: body.invoiceDueDate ?? new Date(Date.now() + (supplier.paymentTermsDays ?? 30) * 86400_000) }], { session });
      }
      return doc;
    });
    await audit(ctx, { action: 'procurement.goods_received', entity: 'GoodsReceivedNote', entityId: grn._id, meta: { total: grn.total, supplier: supplier.name } }, req);
    return grn;
  },
);
m.route({ method: 'get', path: '/grn', summary: 'List goods received notes', permission: P.PROCUREMENT_VIEW }, async ({ ctx }) => GoodsReceivedNote.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ createdAt: -1 }).limit(200).lean());

// ── Supplier invoices & payments & returns ──
m.route({ method: 'get', path: '/supplier-invoices', summary: 'Supplier invoices', permission: [P.PROCUREMENT_VIEW, P.ACCOUNTING_VIEW] }, async ({ ctx }) => SupplierInvoice.find({ tenantId: ctx.tenantId }).sort({ dueDate: 1 }).limit(300).lean());
m.route({ method: 'post', path: '/supplier-invoices/:id/pay', summary: 'Record a supplier payment', permission: P.EXPENSES_MANAGE, body: z.object({ amount: zMoney, method: z.enum(['bank', 'mpesa', 'cash', 'cheque']), reference: z.string().max(60).optional(), notify: z.boolean().optional() }) }, async ({ ctx, params, body, req }) => {
  const inv = await SupplierInvoice.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!inv) throw notFound('Invoice');
  if (body.amount > inv.amount - inv.paid) throw badRequest('Amount exceeds the outstanding balance');
  await withTransaction(async (session) => {
    inv.payments.push({ amount: body.amount, at: new Date(), method: body.method, reference: body.reference, by: ctx.userId });
    inv.paid += body.amount;
    inv.status = inv.paid >= inv.amount ? 'paid' : 'partial';
    await inv.save({ session });
    await Supplier.updateOne({ tenantId: ctx.tenantId, _id: inv.supplierId }, { $inc: { balance: -body.amount } }, { session });
  });
  await audit(ctx, { action: 'procurement.supplier_paid', entity: 'SupplierInvoice', entityId: inv._id, meta: body }, req);
  if (body.notify) {
    const sup = await Supplier.findOne({ tenantId: ctx.tenantId, _id: inv.supplierId }).lean();
    if (sup?.email) await notify(ctx.tenantId, { event: 'supplier_payment', channel: 'email', to: sup.email, vars: { supplier_name: sup.name, amount: (body.amount / 100).toFixed(2), invoice_no: inv.invoiceNo, reference: body.reference ?? '-' }, dedupeKey: `suppay:${inv._id}:${inv.payments.length}` });
  }
  return inv;
});
m.route({ method: 'post', path: '/supplier-returns', summary: 'Return stock to a supplier', permission: P.INVENTORY_MANAGE, status: 201, body: z.object({ supplierId: zId, grnId: zId.optional(), reason: z.string().min(3).max(300), lines: z.array(z.object({ ingredientId: zId, qty: z.number().positive(), unit: z.string().optional(), unitCost: zMoney })).min(1) }) }, async ({ ctx, body, req }) => {
  const ret = await withTransaction(async (session) => {
    const lines = [];
    for (const l of body.lines) {
      const ing = await Ingredient.findOne({ tenantId: ctx.tenantId, _id: l.ingredientId }).session(session).lean();
      if (!ing) throw notFound('Ingredient');
      lines.push({ ingredientId: ing._id, qty: toBaseQty(l.qty, l.unit, ing), unitCost: l.unitCost, credit: Math.round(l.qty * l.unitCost) });
    }
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    const [doc] = await SupplierReturn.create([{ tenantId: ctx.tenantId, branchId: ctx.branchId, supplierId: body.supplierId, grnId: body.grnId, reason: body.reason, lines, creditAmount: credit, by: ctx.userId }], { session });
    for (const l of lines) await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: l.ingredientId, type: 'supplier_return', qty: -l.qty, idempotencyKey: `sret:${doc._id}:${l.ingredientId}`, refType: 'SupplierReturn', refId: doc._id, by: ctx.userId, reason: body.reason }, session);
    await Supplier.updateOne({ tenantId: ctx.tenantId, _id: body.supplierId }, { $inc: { balance: -credit } }, { session });
    return doc;
  });
  await audit(ctx, { action: 'procurement.supplier_return', entity: 'SupplierReturn', entityId: ret._id, reason: body.reason }, req);
  return ret;
});

// ── Bar: bottle stock view ──
m.route({ method: 'get', path: '/bar-stock', summary: 'Bar stock in bottles/kegs (bottle-to-glass)', permission: [P.INVENTORY_VIEW, P.BAR_VIEW] }, async ({ ctx }) => {
  const ings = await Ingredient.find({ tenantId: ctx.tenantId, isBarItem: true }).lean();
  const bals = await StockBalance.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: { $in: ings.map((i) => i._id) } }).lean();
  return ings.map((i) => {
    const qty = bals.find((b) => String(b.ingredientId) === String(i._id))?.qty ?? 0;
    const size = i.containerSize ?? 0;
    return { id: i._id, name: i.name, baseUnit: i.baseUnit, qty, containerSize: size, fullContainers: size ? Math.floor(qty / size) : null, openContainerRemaining: size ? round(qty % size, 1) : null, minLevel: i.minLevel, low: qty <= (i.minLevel ?? 0) };
  });
});

export async function lowStockItems(tenantId: Types.ObjectId, branchId: Types.ObjectId) {
  const ings = await Ingredient.find({ tenantId, active: true, minLevel: { $gt: 0 } }).lean();
  const bals = await StockBalance.find({ tenantId, branchId, ingredientId: { $in: ings.map((i) => i._id) } }).lean();
  return ings.map((i) => ({ i, qty: bals.find((b) => String(b.ingredientId) === String(i._id))?.qty ?? 0 })).filter((x) => x.qty <= (x.i.minLevel ?? 0)).map((x) => ({ name: x.i.name, qty: x.qty, unit: x.i.baseUnit, min: x.i.minLevel }));
}

export default m;
