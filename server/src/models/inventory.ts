import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, branchRef, money } from './common';

/** Base units: g, ml, pcs. Purchase/serving units are converted to the base unit. */
const ingredientSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true, trim: true },
    sku: String,
    kind: { type: String, enum: ['raw', 'finished', 'packaged_beverage', 'spirit', 'beer', 'wine', 'mixer', 'packaging', 'other'], default: 'raw' },
    baseUnit: { type: String, enum: ['g', 'ml', 'pcs'], required: true },
    /** Named units convertible to the base unit, e.g. { name: 'bottle', factor: 750 } for a 750ml bottle. */
    units: [{ name: String, factor: Number }],
    /** Container size in base units (bottle/keg) for bottle-to-glass conversion and open-bottle tracking. */
    containerSize: Number,
    isBarItem: { type: Boolean, default: false },
    trackExpiry: { type: Boolean, default: false },
    minLevel: { type: Number, default: 0 },
    maxLevel: Number,
    reorderQty: Number,
    lastCost: { type: Number, default: 0 }, // cents per base unit (fractional allowed)
    preferredSupplierId: Schema.Types.ObjectId,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
ingredientSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Ingredient = model('Ingredient', ingredientSchema);

/** Cached running balance. The StockLedger is the source of truth; balances can be rebuilt from it. */
const stockBalanceSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    qty: { type: Number, default: 0 },
    /** Inventory value in cents (fractional allowed — unit costs per gram/ml are sub-cent). */
    value: { type: Number, default: 0 },
    lastMovementAt: Date,
  },
  schemaOpts,
);
stockBalanceSchema.index({ tenantId: 1, branchId: 1, ingredientId: 1 }, { unique: true });
export const StockBalance = model('StockBalance', stockBalanceSchema);

export const LEDGER_TYPES = [
  'receipt', 'sale', 'sale_reversal', 'adjustment', 'wastage', 'breakage', 'spoilage', 'complimentary', 'transfer_in',
  'transfer_out', 'count_variance', 'supplier_return', 'opening',
] as const;

/** Append-only stock movement ledger. */
const stockLedgerSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    qty: { type: Number, required: true }, // signed, base units
    unitCost: { type: Number, default: 0 }, // cents per base unit
    totalCost: { type: Number, default: 0 }, // cents (signed)
    balanceAfter: Number,
    refType: String,
    refId: Schema.Types.ObjectId,
    refLine: String,
    reason: String,
    recipeVersionId: Schema.Types.ObjectId,
    lotAllocations: [{ lotId: Schema.Types.ObjectId, qty: Number, unitCost: Number }],
    by: Schema.Types.ObjectId,
    /** Unique per movement — prevents double deduction on retries and sync. */
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stockLedgerSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
stockLedgerSchema.index({ tenantId: 1, branchId: 1, ingredientId: 1, createdAt: -1 });
stockLedgerSchema.index({ tenantId: 1, branchId: 1, type: 1, createdAt: -1 });
export const StockLedger = model('StockLedger', stockLedgerSchema);

/** Received batches for FIFO costing and expiry tracking. */
const stockLotSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    ingredientId: { type: Schema.Types.ObjectId, required: true },
    receivedAt: { type: Date, default: Date.now },
    qtyReceived: Number,
    qtyRemaining: { type: Number, required: true },
    unitCost: { type: Number, required: true }, // cents per base unit
    batchNo: String,
    expiresAt: Date,
    sourceType: String,
    sourceId: Schema.Types.ObjectId,
  },
  schemaOpts,
);
stockLotSchema.index({ tenantId: 1, branchId: 1, ingredientId: 1, qtyRemaining: 1, receivedAt: 1 });
export const StockLot = model('StockLot', stockLotSchema);

const recipeSchema = new Schema(
  {
    tenantId: tenantRef,
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: String, default: '' },
    currentVersionId: Schema.Types.ObjectId,
    currentVersion: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
recipeSchema.index({ tenantId: 1, productId: 1, variant: 1 }, { unique: true });
export const Recipe = model('Recipe', recipeSchema);

/** Immutable recipe snapshot. Orders reference the version in force when the item was sold. */
const recipeVersionSchema = new Schema(
  {
    tenantId: tenantRef,
    recipeId: { type: Schema.Types.ObjectId, required: true, index: true },
    productId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    yield: { type: Number, default: 1 },
    lines: [{ ingredientId: { type: Schema.Types.ObjectId, required: true }, ingredientName: String, qty: { type: Number, required: true }, unit: String, baseQty: { type: Number, required: true } }],
    notes: String,
    createdBy: Schema.Types.ObjectId,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
recipeVersionSchema.index({ tenantId: 1, recipeId: 1, version: 1 }, { unique: true });
export const RecipeVersion = model('RecipeVersion', recipeVersionSchema);

/** Adjustments (wastage, breakage, write-offs...) that require approval before posting to the ledger. */
const stockAdjustmentSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    type: { type: String, enum: ['adjustment', 'wastage', 'breakage', 'spoilage', 'complimentary'], required: true },
    lines: [{ ingredientId: Schema.Types.ObjectId, qty: Number, unit: String, baseQty: Number, note: String }],
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    requestedBy: Schema.Types.ObjectId,
    approvedBy: Schema.Types.ObjectId,
    approvedAt: Date,
    rejectionReason: String,
  },
  schemaOpts,
);
export const StockAdjustment = model('StockAdjustment', stockAdjustmentSchema);

const stockCountSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    name: String,
    status: { type: String, enum: ['draft', 'submitted', 'posted'], default: 'draft' },
    lines: [{ ingredientId: Schema.Types.ObjectId, ingredientName: String, expectedQty: Number, countedQty: Number, variance: Number }],
    countedBy: Schema.Types.ObjectId,
    postedBy: Schema.Types.ObjectId,
    postedAt: Date,
  },
  schemaOpts,
);
export const StockCount = model('StockCount', stockCountSchema);

const stockTransferSchema = new Schema(
  {
    tenantId: tenantRef,
    fromBranchId: { type: Schema.Types.ObjectId, required: true },
    toBranchId: { type: Schema.Types.ObjectId, required: true },
    number: String,
    lines: [{ ingredientId: Schema.Types.ObjectId, qty: Number }],
    status: { type: String, enum: ['draft', 'dispatched', 'received', 'cancelled'], default: 'draft' },
    dispatchedBy: Schema.Types.ObjectId,
    receivedBy: Schema.Types.ObjectId,
    notes: String,
  },
  schemaOpts,
);
export const StockTransfer = model('StockTransfer', stockTransferSchema);

const supplierSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true },
    contactName: String,
    phone: String,
    email: String,
    kraPin: String,
    address: String,
    paymentTermsDays: { type: Number, default: 30 },
    balance: { ...money }, // amount owed to supplier (cents)
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
supplierSchema.index({ tenantId: 1, name: 1 }, { unique: true });
export const Supplier = model('Supplier', supplierSchema);

const purchaseOrderSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    supplierId: { type: Schema.Types.ObjectId, required: true },
    number: { type: String, required: true },
    status: { type: String, enum: ['draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'], default: 'draft' },
    lines: [{ ingredientId: Schema.Types.ObjectId, ingredientName: String, qty: Number, unit: String, unitFactor: Number, unitPrice: Number, receivedQty: { type: Number, default: 0 } }],
    total: { ...money },
    expectedAt: Date,
    notes: String,
    createdBy: Schema.Types.ObjectId,
    approvedBy: Schema.Types.ObjectId,
    emailedAt: Date,
  },
  schemaOpts,
);
purchaseOrderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const PurchaseOrder = model('PurchaseOrder', purchaseOrderSchema);

const grnSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    supplierId: { type: Schema.Types.ObjectId, required: true },
    purchaseOrderId: Schema.Types.ObjectId,
    number: { type: String, required: true },
    supplierInvoiceNo: String,
    lines: [{ ingredientId: Schema.Types.ObjectId, ingredientName: String, qty: Number, unit: String, unitFactor: Number, baseQty: Number, unitPrice: Number, batchNo: String, expiresAt: Date }],
    total: { ...money },
    receivedBy: Schema.Types.ObjectId,
    receivedAt: { type: Date, default: Date.now },
  },
  schemaOpts,
);
grnSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const GoodsReceivedNote = model('GoodsReceivedNote', grnSchema);

const supplierInvoiceSchema = new Schema(
  {
    tenantId: tenantRef,
    supplierId: { type: Schema.Types.ObjectId, required: true, index: true },
    grnId: Schema.Types.ObjectId,
    invoiceNo: { type: String, required: true },
    amount: money,
    paid: { ...money },
    dueDate: Date,
    status: { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid' },
    payments: [{ amount: Number, at: Date, method: String, reference: String, by: Schema.Types.ObjectId }],
  },
  schemaOpts,
);
supplierInvoiceSchema.index({ tenantId: 1, supplierId: 1, invoiceNo: 1 }, { unique: true });
export const SupplierInvoice = model('SupplierInvoice', supplierInvoiceSchema);

const supplierReturnSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    supplierId: { type: Schema.Types.ObjectId, required: true },
    grnId: Schema.Types.ObjectId,
    lines: [{ ingredientId: Schema.Types.ObjectId, qty: Number, unitCost: Number }],
    reason: { type: String, required: true },
    creditAmount: { ...money },
    by: Schema.Types.ObjectId,
  },
  schemaOpts,
);
export const SupplierReturn = model('SupplierReturn', supplierReturnSchema);
