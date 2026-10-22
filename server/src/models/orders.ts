import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { schemaOpts, tenantRef, branchRef, money } from './common';

export const ITEM_STATUSES = ['new', 'pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled'] as const;
export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'room_service', 'bar_counter', 'online'] as const;

const orderItemSchema = new Schema(
  {
    lineId: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    categoryId: Schema.Types.ObjectId,
    station: { type: String, enum: ['kitchen', 'bar', 'none'], default: 'kitchen' },
    qty: { type: Number, required: true, min: 0.001 },
    unitPrice: money, // incl. modifiers, as charged
    modifiers: [{ groupName: String, name: String, priceDelta: { ...money } }],
    variant: String,
    notes: { type: String, maxlength: 300 },
    discount: { ...money },
    lineTotal: money, // qty * unitPrice - discount (gross, tax-inclusive or exclusive depending on tax config)
    taxes: [{ code: String, rateBps: Number, inclusive: Boolean, amount: { ...money } }],
    serviceChargeApplies: { type: Boolean, default: true },
    taxRateIds: [Schema.Types.ObjectId],
    ageRestricted: { type: Boolean, default: false },
    recipeVersionId: { type: Schema.Types.ObjectId, ref: 'RecipeVersion' },
    stockOverride: { by: Schema.Types.ObjectId, reason: String },
    status: { type: String, enum: ITEM_STATUSES, default: 'new' },
    priority: { type: Boolean, default: false },
    ticketId: Schema.Types.ObjectId,
    sentAt: Date,
    readyAt: Date,
    servedAt: Date,
    voided: { type: Boolean, default: false },
    voidReason: String,
    voidedBy: Schema.Types.ObjectId,
    approvedBy: Schema.Types.ObjectId,
    complimentary: { type: Boolean, default: false },
    addedBy: Schema.Types.ObjectId,
    ageCheckConfirmed: Boolean,
    happyHour: Boolean,
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    number: { type: String, required: true },
    /** Client-generated UUID — guarantees offline sync and retried submissions never duplicate an order. */
    clientId: { type: String, required: true },
    source: { type: String, enum: ['pos', 'offline', 'online', 'api'], default: 'pos' },
    type: { type: String, enum: ORDER_TYPES, default: 'dine_in' },
    status: { type: String, enum: ['open', 'held', 'paid', 'voided', 'merged'], default: 'open', index: true },
    paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'refunded', 'partially_refunded'], default: 'unpaid' },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table' },
    tableNumber: String,
    guests: { type: Number, default: 1 },
    waiterId: { type: Schema.Types.ObjectId, ref: 'User' },
    waiterName: String,
    cashierId: { type: Schema.Types.ObjectId, ref: 'User' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: String,
    customerPhone: String,
    items: { type: [orderItemSchema], validate: [(v: unknown[]) => v.length <= 300, 'An order may contain at most 300 lines'] },
    notes: String,
    priority: { type: Boolean, default: false },
    discount: {
      type: { type: String, enum: ['percent', 'amount', 'none'], default: 'none' },
      value: { type: Number, default: 0 },
      amount: { ...money },
      reason: String,
      approvedBy: Schema.Types.ObjectId,
      couponCode: String,
    },
    totals: {
      subtotal: { ...money }, // sum of line totals
      discount: { ...money },
      serviceCharge: { ...money },
      taxInclusive: { ...money },
      taxExclusive: { ...money },
      deliveryFee: { ...money },
      total: { ...money },
      paid: { ...money },
      refunded: { ...money },
      balance: { ...money },
    },
    taxBreakdown: [{ code: String, rateBps: Number, inclusive: Boolean, amount: Number }],
    delivery: {
      address: String,
      landmark: String,
      contactPhone: String,
      zoneId: Schema.Types.ObjectId,
      riderId: Schema.Types.ObjectId,
      riderName: String,
      status: { type: String, enum: ['pending', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'] },
      estimatedReadyAt: Date,
      deliveredAt: Date,
      trackingCode: String,
    },
    mergedInto: Schema.Types.ObjectId,
    splitFrom: Schema.Types.ObjectId,
    receiptNumber: String,
    paidAt: Date,
    voidedAt: Date,
    voidReason: String,
    stockDeducted: { type: Boolean, default: false },
    loyaltyAwarded: { type: Boolean, default: false },
    cashSessionId: Schema.Types.ObjectId,
    offline: {
      createdAt: Date,
      terminalId: String,
      syncedAt: Date,
      priceConflicts: [{ lineId: String, offlinePrice: Number, currentPrice: Number }],
    },
  },
  { ...schemaOpts, optimisticConcurrency: true },
);
orderSchema.index({ tenantId: 1, clientId: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, branchId: 1, paidAt: -1 });
orderSchema.index({ tenantId: 1, 'delivery.trackingCode': 1 }, { sparse: true });
export const Order = model('Order', orderSchema);
export type OrderDoc = HydratedDocument<InferSchemaType<typeof orderSchema>>;
export type OrderItem = InferSchemaType<typeof orderItemSchema>;

const kitchenTicketSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderNumber: String,
    station: { type: String, enum: ['kitchen', 'bar'], required: true },
    tableNumber: String,
    orderType: String,
    waiterName: String,
    priority: { type: Boolean, default: false },
    items: [
      { lineId: String, name: String, qty: Number, modifiers: [String], notes: String, status: String, ageRestricted: Boolean },
    ],
    status: { type: String, enum: ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'], default: 'pending', index: true },
    acceptedAt: Date,
    startedAt: Date,
    readyAt: Date,
    completedAt: Date,
    handledBy: Schema.Types.ObjectId,
    /** Idempotency: one ticket per order submission. */
    submissionKey: { type: String, required: true },
  },
  schemaOpts,
);
kitchenTicketSchema.index({ tenantId: 1, submissionKey: 1, station: 1 }, { unique: true });
kitchenTicketSchema.index({ tenantId: 1, branchId: 1, station: 1, status: 1, createdAt: 1 });
export const KitchenTicket = model('KitchenTicket', kitchenTicketSchema);

const receiptSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: ['bill', 'receipt'], default: 'receipt' },
    printCount: { type: Number, default: 0 },
    prints: [{ at: Date, by: Schema.Types.ObjectId, copy: { type: String, enum: ['original', 'duplicate'] }, printer: String, status: String, error: String, reason: String }],
    emailedTo: [String],
    smsTo: [String],
  },
  schemaOpts,
);
receiptSchema.index({ tenantId: 1, orderId: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'receipt' } });
receiptSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const Receipt = model('Receipt', receiptSchema);
