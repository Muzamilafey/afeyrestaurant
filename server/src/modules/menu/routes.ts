import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { createModule, zId, zMoney } from '../../http/route';
import { Category, Product, ModifierGroup, PriceHistory, Recipe, RecipeVersion, StockBalance, TaxRate, Branch, Tenant } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { audit } from '../../services/audit';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { env } from '../../config/env';
import { localParts, resolvePrice, inWindow } from '../../services/pricing';
import { dayRange, localDate } from '../../lib/time';
import { emitBranch } from '../../realtime/bus';

const m = createModule('/menu', 'Menu');

const zCategory = z.object({ name: z.string().min(1).max(60), icon: z.string().max(40).optional(), kind: z.enum(['food', 'soft_drink', 'alcohol', 'cocktail', 'beer', 'wine', 'spirit', 'other']), station: z.enum(['kitchen', 'bar', 'none']), sortOrder: z.number().int().optional(), active: z.boolean().optional() });
m.route({ method: 'get', path: '/categories', summary: 'List categories', permission: P.MENU_VIEW }, async ({ ctx }) => Category.find({ tenantId: ctx.tenantId }).sort({ sortOrder: 1, name: 1 }).lean());
m.route({ method: 'post', path: '/categories', summary: 'Create category', permission: P.MENU_MANAGE, body: zCategory, status: 201 }, async ({ ctx, body }) => Category.create({ ...body, tenantId: ctx.tenantId }));
m.route({ method: 'patch', path: '/categories/:id', summary: 'Update category', permission: P.MENU_MANAGE, body: zCategory.partial() }, async ({ ctx, body, params }) => {
  const c = await Category.findOneAndUpdate({ tenantId: ctx.tenantId, _id: params.id }, { $set: body }, { new: true });
  if (!c) throw notFound('Category');
  return c;
});

const zModGroup = z.object({ name: z.string().min(1).max(60), minSelect: z.number().int().min(0).max(20), maxSelect: z.number().int().min(1).max(20), options: z.array(z.object({ _id: zId.optional(), name: z.string().min(1).max(60), priceDelta: z.number().int(), active: z.boolean().optional() })).max(50) });
m.route({ method: 'get', path: '/modifier-groups', summary: 'List modifier groups', permission: P.MENU_VIEW }, async ({ ctx }) => ModifierGroup.find({ tenantId: ctx.tenantId }).lean());
m.route({ method: 'post', path: '/modifier-groups', summary: 'Create modifier group', permission: P.MENU_MANAGE, body: zModGroup, status: 201 }, async ({ ctx, body }) => {
  if (body.minSelect > body.maxSelect) throw badRequest('Minimum cannot exceed maximum');
  return ModifierGroup.create({ ...body, tenantId: ctx.tenantId });
});
m.route({ method: 'put', path: '/modifier-groups/:id', summary: 'Update modifier group', permission: P.MENU_MANAGE, body: zModGroup }, async ({ ctx, body, params }) => {
  const g = await ModifierGroup.findOneAndUpdate({ tenantId: ctx.tenantId, _id: params.id }, { $set: body }, { new: true });
  if (!g) throw notFound('Modifier group');
  return g;
});

const zProduct = z.object({
  categoryId: zId, name: z.string().min(1).max(100), description: z.string().max(500).optional(), imageUrl: z.string().max(500).optional(),
  sku: z.string().max(40).optional(), barcode: z.string().max(40).optional(), plu: z.string().max(10).optional(), price: zMoney,
  branchPrices: z.array(z.object({ branchId: zId, price: zMoney })).optional(), happyHourPrice: zMoney.nullable().optional(),
  variants: z.array(z.object({ name: z.string().min(1).max(40), price: zMoney, sku: z.string().optional() })).max(10).optional(),
  modifierGroupIds: z.array(zId).optional(), taxRateIds: z.array(zId).optional(), serviceChargeApplies: z.boolean().optional(),
  station: z.enum(['kitchen', 'bar', 'none', 'inherit']).optional(),
  dietary: z.array(z.enum(['vegetarian', 'vegan', 'halal', 'gluten_free', 'spicy', 'dairy_free', 'contains_nuts'])).optional(),
  allergens: z.array(z.string().max(40)).optional(), ageRestricted: z.boolean().optional(),
  status: z.enum(['available', 'sold_out', 'seasonal', 'archived']).optional(),
  availability: z.object({ branchIds: z.array(zId).optional(), days: z.array(z.number().int().min(0).max(6)).optional(), start: z.string().regex(/^\d{2}:\d{2}$/).optional(), end: z.string().regex(/^\d{2}:\d{2}$/).optional() }).optional(),
  combo: z.object({ isCombo: z.boolean(), items: z.array(z.object({ productId: zId, qty: z.number().positive() })) }).optional(),
  prepMinutes: z.number().int().min(0).max(240).optional(), sortOrder: z.number().int().optional(),
});

/** POS catalogue: products with current price, availability and stock warnings for the active branch. */
m.route({ method: 'get', path: '/catalog', summary: 'POS catalogue for the active branch', permission: P.MENU_VIEW }, async ({ ctx }) => {
  await restoreExpiredSoldOut(ctx.tenantId);
  const [tenant, branch, categories, products, groups, taxes] = await Promise.all([
    Tenant.findById(ctx.tenantId).lean(),
    Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }).lean(),
    Category.find({ tenantId: ctx.tenantId, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Product.find({ tenantId: ctx.tenantId, status: { $ne: 'archived' } }).sort({ sortOrder: 1, name: 1 }).lean(),
    ModifierGroup.find({ tenantId: ctx.tenantId }).lean(),
    TaxRate.find({ tenantId: ctx.tenantId, active: true }).lean(),
  ]);
  const now = localParts(tenant?.settings?.timezone ?? 'Africa/Nairobi');
  const recipes = await Recipe.find({ tenantId: ctx.tenantId, productId: { $in: products.map((p) => p._id) }, active: true, variant: '' }).lean();
  const versions = await RecipeVersion.find({ tenantId: ctx.tenantId, _id: { $in: recipes.map((r) => r.currentVersionId).filter(Boolean) } }).lean();
  const ingredientIds = versions.flatMap((v) => v.lines.map((l) => l.ingredientId));
  const balances = await StockBalance.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: { $in: ingredientIds } }).lean();
  const bal = new Map(balances.map((b) => [String(b.ingredientId), b.qty]));
  const out = products
    .filter((p) => !p.availability?.branchIds?.length || p.availability.branchIds.some((b) => String(b) === String(ctx.branchId)))
    .map((p) => {
      const r = recipes.find((x) => String(x.productId) === String(p._id));
      const v = r ? versions.find((x) => String(x._id) === String(r.currentVersionId)) : null;
      let servingsLeft: number | null = null;
      if (v?.lines.length) servingsLeft = Math.max(0, Math.floor(Math.min(...v.lines.map((l) => ((bal.get(String(l.ingredientId)) ?? 0) * (v.yield || 1)) / l.baseQty))));
      const price = resolvePrice(p, { branchId: ctx.branchId, happyHours: branch?.settings?.happyHours as never, now });
      const scheduled = (!p.availability?.days?.length || p.availability.days.includes(now.day)) && inWindow(now.time, p.availability?.start, p.availability?.end);
      return {
        ...p,
        currentPrice: 'price' in price ? price.price : p.price,
        happyHour: 'happyHour' in price ? price.happyHour : false,
        available: p.status === 'available' && scheduled && servingsLeft !== 0,
        unavailableReason: p.status !== 'available' ? p.status : !scheduled ? 'not_scheduled' : servingsLeft === 0 ? 'out_of_stock' : null,
        servingsLeft,
        lowStock: servingsLeft !== null && servingsLeft > 0 && servingsLeft <= 5,
        hasRecipe: !!v,
      };
    });
  return { categories, products: out, modifierGroups: groups, taxes, serverTime: new Date().toISOString() };
});

/** Items marked sold out "for today" come back on sale once that time has passed. */
export async function restoreExpiredSoldOut(tenantId: unknown) {
  await Product.updateMany({ tenantId, status: 'sold_out', soldOutUntil: { $lte: new Date() } }, { $set: { status: 'available' }, $unset: { soldOutUntil: 1, soldOutBy: 1, soldOutAt: 1 } });
}

/**
 * Sold out ("86") / back on sale in one tap, from the POS or the kitchen/bar screen. By default an item is sold out
 * until the end of the business day; every till updates immediately.
 */
m.route(
  {
    method: 'post', path: '/products/:id/sold-out', summary: 'Mark a product sold out / back on sale', permission: [P.MENU_MANAGE, P.KITCHEN_UPDATE, P.BAR_UPDATE, P.ORDERS_UPDATE],
    body: z.object({ soldOut: z.boolean(), until: z.enum(['end_of_day', 'manual']).default('end_of_day') }),
  },
  async ({ ctx, params, body, req }) => {
    const p = await Product.findOne({ tenantId: ctx.tenantId, _id: params.id, status: { $in: ['available', 'sold_out'] } });
    if (!p) throw notFound('Product');
    if (body.soldOut) {
      const tenant = await Tenant.findById(ctx.tenantId).select('settings.timezone').lean();
      const tz = tenant?.settings?.timezone ?? 'Africa/Nairobi';
      p.set({ status: 'sold_out', soldOutBy: ctx.userName, soldOutAt: new Date(), soldOutUntil: body.until === 'end_of_day' ? dayRange(localDate(tz), tz).end : undefined });
    } else {
      p.set({ status: 'available', soldOutUntil: undefined, soldOutBy: undefined, soldOutAt: undefined });
    }
    await p.save();
    await audit(ctx, { action: body.soldOut ? 'menu.sold_out' : 'menu.back_on_sale', entity: 'Product', entityId: p._id, meta: { name: p.name, until: p.soldOutUntil } }, req);
    const branches = await Branch.find({ tenantId: ctx.tenantId }).select('_id').lean();
    for (const b of branches) emitBranch(ctx.tenantId, b._id, 'menu.updated', { productId: String(p._id), status: p.status });
    return { _id: p._id, name: p.name, status: p.status, soldOutUntil: p.soldOutUntil, soldOutBy: p.soldOutBy };
  },
);

m.route({ method: 'get', path: '/products', summary: 'List/search products (name, SKU, barcode, PLU)', permission: P.MENU_VIEW, query: z.object({ q: z.string().max(60).optional(), categoryId: zId.optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (query.categoryId) f.categoryId = query.categoryId;
  if (query.status) f.status = query.status;
  if (query.q) {
    const rx = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ name: rx }, { sku: query.q }, { barcode: query.q }, { plu: query.q }];
  }
  return Product.find(f).sort({ sortOrder: 1, name: 1 }).limit(500).lean();
});

m.route({ method: 'post', path: '/products', summary: 'Create product', permission: P.MENU_MANAGE, body: zProduct, status: 201 }, async ({ ctx, body, req }) => {
  if (!(await Category.exists({ tenantId: ctx.tenantId, _id: body.categoryId }))) throw badRequest('Unknown category');
  const p = await Product.create({ ...body, tenantId: ctx.tenantId });
  await audit(ctx, { action: 'menu.product_created', entity: 'Product', entityId: p._id, after: { name: p.name, price: p.price } }, req);
  return p;
});

m.route({ method: 'patch', path: '/products/:id', summary: 'Update product (price changes need menu.price_change)', permission: P.MENU_MANAGE, body: zProduct.partial().extend({ priceChangeReason: z.string().max(200).optional() }) }, async ({ ctx, body, params, req }) => {
  const p = await Product.findOne({ tenantId: ctx.tenantId, _id: params.id });
  if (!p) throw notFound('Product');
  const { priceChangeReason, ...patch } = body;
  const priceChanged = (patch.price !== undefined && patch.price !== p.price) || patch.branchPrices !== undefined || patch.happyHourPrice !== undefined || patch.variants !== undefined;
  if (priceChanged && !ctx.permissions.has(P.MENU_PRICE_CHANGE)) throw new AppError(403, 'FORBIDDEN', 'Missing permission: menu.price_change');
  if (patch.price !== undefined && patch.price !== p.price) {
    await PriceHistory.create({ tenantId: ctx.tenantId, productId: p._id, field: 'price', oldPrice: p.price, newPrice: patch.price, changedBy: ctx.userId, reason: priceChangeReason });
  }
  for (const bp of patch.branchPrices ?? []) {
    const old = p.branchPrices?.find((x) => String(x.branchId) === bp.branchId)?.price;
    if (old !== bp.price) await PriceHistory.create({ tenantId: ctx.tenantId, productId: p._id, branchId: bp.branchId, field: 'branch_price', oldPrice: old, newPrice: bp.price, changedBy: ctx.userId, reason: priceChangeReason });
  }
  const before = { price: p.price, status: p.status };
  p.set(patch);
  await p.save();
  await audit(ctx, { action: priceChanged ? 'menu.price_changed' : 'menu.product_updated', entity: 'Product', entityId: p._id, reason: priceChangeReason, before, after: { price: p.price, status: p.status } }, req);
  return p;
});

m.route({ method: 'get', path: '/products/:id/price-history', summary: 'Price change history', permission: P.MENU_VIEW }, async ({ ctx, params }) => PriceHistory.find({ tenantId: ctx.tenantId, productId: params.id }).sort({ createdAt: -1 }).limit(100).lean());

// Image upload with size and MIME validation; files stored under UPLOAD_DIR/<tenantId>/ with random names.
const ALLOWED = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp']]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(new AppError(415, 'UNSUPPORTED_MEDIA', 'Only JPEG, PNG or WebP images are allowed'))),
});
function sniff(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
m.route({ method: 'post', path: '/uploads/image', summary: 'Upload a product image or business logo (multipart field "file")', permission: [P.MENU_MANAGE, P.SETTINGS_MANAGE], middleware: [upload.single('file') as never], status: 201 }, async ({ ctx, req }) => {
  const file = req.file;
  if (!file) throw badRequest('No file uploaded');
  const actual = sniff(file.buffer);
  if (!actual || actual !== file.mimetype) throw new AppError(415, 'UNSUPPORTED_MEDIA', 'File content does not match an allowed image type');
  const dir = path.resolve(env.UPLOAD_DIR, String(ctx.tenantId));
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${randomUUID()}${ALLOWED.get(actual)}`;
  await fs.promises.writeFile(path.join(dir, name), file.buffer, { mode: 0o640 });
  return { url: `/uploads/${ctx.tenantId}/${name}` };
});

export default m;
