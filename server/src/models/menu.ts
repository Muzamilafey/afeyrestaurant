import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, money, optMoney } from './common';

const taxRateSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true }, // e.g. "VAT 16%", "Catering Levy 2%"
    code: { type: String, required: true },
    rateBps: { type: Number, required: true, min: 0, max: 10000 },
    inclusive: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
taxRateSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const TaxRate = model('TaxRate', taxRateSchema);

const categorySchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true },
    icon: { type: String, default: 'utensils' },
    kind: { type: String, enum: ['food', 'soft_drink', 'alcohol', 'cocktail', 'beer', 'wine', 'spirit', 'other'], default: 'food' },
    station: { type: String, enum: ['kitchen', 'bar', 'none'], default: 'kitchen' },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
categorySchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Category = model('Category', categorySchema);

const modifierGroupSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true }, // "Size", "Extras", "Doneness"
    minSelect: { type: Number, default: 0 },
    maxSelect: { type: Number, default: 1 },
    options: {
      type: [{ name: { type: String, required: true }, priceDelta: { ...money }, active: { type: Boolean, default: true } }],
      validate: [(v: unknown[]) => v.length <= 50, 'Too many options'],
    },
  },
  schemaOpts,
);
export const ModifierGroup = model('ModifierGroup', modifierGroupSchema);

const productSchema = new Schema(
  {
    tenantId: tenantRef,
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: String,
    imageUrl: String,
    sku: { type: String, trim: true },
    barcode: { type: String, trim: true },
    plu: { type: String, trim: true },
    price: money,
    /** Branch-specific price overrides. */
    branchPrices: [{ branchId: Schema.Types.ObjectId, price: { ...money } }],
    happyHourPrice: optMoney,
    variants: [{ name: String, price: { ...money }, sku: String }],
    modifierGroupIds: [{ type: Schema.Types.ObjectId, ref: 'ModifierGroup' }],
    taxRateIds: [{ type: Schema.Types.ObjectId, ref: 'TaxRate' }],
    serviceChargeApplies: { type: Boolean, default: true },
    station: { type: String, enum: ['kitchen', 'bar', 'none', 'inherit'], default: 'inherit' },
    dietary: [{ type: String, enum: ['vegetarian', 'vegan', 'halal', 'gluten_free', 'spicy', 'dairy_free', 'contains_nuts'] }],
    allergens: [String],
    ageRestricted: { type: Boolean, default: false },
    status: { type: String, enum: ['available', 'sold_out', 'seasonal', 'archived'], default: 'available', index: true },
    /** Sold out from the POS / kitchen ("86"): back on sale automatically at this time (null = until switched back). */
    soldOutUntil: Date,
    soldOutBy: String,
    soldOutAt: Date,
    availability: {
      branchIds: [Schema.Types.ObjectId], // empty = all branches
      days: [Number], // 0=Sun..6, empty = every day
      start: String, // "HH:mm"
      end: String,
    },
    combo: {
      isCombo: { type: Boolean, default: false },
      items: [{ productId: Schema.Types.ObjectId, qty: Number }],
    },
    prepMinutes: { type: Number, default: 10 },
    sortOrder: { type: Number, default: 0 },
  },
  schemaOpts,
);
productSchema.index({ tenantId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } });
productSchema.index({ tenantId: 1, barcode: 1 }, { partialFilterExpression: { barcode: { $type: 'string' } } });
productSchema.index({ tenantId: 1, plu: 1 }, { partialFilterExpression: { plu: { $type: 'string' } } });
productSchema.index({ tenantId: 1, name: 'text', sku: 'text' });
export const Product = model('Product', productSchema);

const priceHistorySchema = new Schema(
  {
    tenantId: tenantRef,
    productId: { type: Schema.Types.ObjectId, required: true, index: true },
    branchId: Schema.Types.ObjectId,
    field: { type: String, default: 'price' },
    oldPrice: Number,
    newPrice: Number,
    changedBy: Schema.Types.ObjectId,
    reason: String,
  },
  schemaOpts,
);
export const PriceHistory = model('PriceHistory', priceHistorySchema);
