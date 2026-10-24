import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, branchRef, money } from './common';

const customerSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true, trim: true },
    phone: String, // normalised MSISDN
    email: { type: String, lowercase: true, trim: true },
    birthday: { month: Number, day: Number }, // no birth year needed
    tags: [String],
    consent: {
      marketingSms: { type: Boolean, default: false },
      marketingEmail: { type: Boolean, default: false },
      birthdayOffers: { type: Boolean, default: false },
      updatedAt: Date,
      source: String,
    },
    credit: {
      approved: { type: Boolean, default: false },
      limit: { ...money },
      balance: { ...money }, // amount owed by customer
      approvedBy: Schema.Types.ObjectId,
    },
    visits: { type: Number, default: 0 },
    totalSpent: { ...money },
    lastVisitAt: Date,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
customerSchema.index({ tenantId: 1, phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
customerSchema.index({ tenantId: 1, name: 1 });
export const Customer = model('Customer', customerSchema);

/** Restricted-access notes (customers.notes permission). Kept separate so normal lookups never load them. */
const customerNoteSchema = new Schema(
  { tenantId: tenantRef, customerId: { type: Schema.Types.ObjectId, required: true, index: true }, note: { type: String, required: true, maxlength: 1000 }, by: Schema.Types.ObjectId },
  schemaOpts,
);
export const CustomerNote = model('CustomerNote', customerNoteSchema);

const loyaltyAccountSchema = new Schema(
  {
    tenantId: tenantRef,
    customerId: { type: Schema.Types.ObjectId, required: true },
    points: { type: Number, default: 0 },
    lifetimePoints: { type: Number, default: 0 },
    tier: { type: String, default: 'standard' },
  },
  schemaOpts,
);
loyaltyAccountSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });
export const LoyaltyAccount = model('LoyaltyAccount', loyaltyAccountSchema);

const loyaltyTxSchema = new Schema(
  {
    tenantId: tenantRef,
    customerId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ['earn', 'redeem', 'adjust', 'expire'], required: true },
    points: { type: Number, required: true },
    orderId: Schema.Types.ObjectId,
    note: String,
    idempotencyKey: { type: String, required: true },
  },
  schemaOpts,
);
loyaltyTxSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
export const LoyaltyTransaction = model('LoyaltyTransaction', loyaltyTxSchema);

const couponSchema = new Schema(
  {
    tenantId: tenantRef,
    code: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: ['percent', 'amount'], required: true },
    value: { type: Number, required: true },
    minSpend: { ...money },
    validFrom: Date,
    validTo: Date,
    maxUses: Number,
    uses: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Coupon = model('Coupon', couponSchema);

const feedbackSchema = new Schema(
  { tenantId: tenantRef, branchId: branchRef, customerId: Schema.Types.ObjectId, orderId: Schema.Types.ObjectId, rating: { type: Number, min: 1, max: 5 }, comment: String },
  schemaOpts,
);
export const Feedback = model('Feedback', feedbackSchema);

const deliveryZoneSchema = new Schema(
  { tenantId: tenantRef, branchId: branchRef, name: { type: String, required: true }, fee: { ...money }, minOrder: { ...money }, etaMinutes: { type: Number, default: 45 }, active: { type: Boolean, default: true } },
  schemaOpts,
);
export const DeliveryZone = model('DeliveryZone', deliveryZoneSchema);

const riderSchema = new Schema(
  {
    tenantId: tenantRef, branchId: branchRef, name: { type: String, required: true }, phone: String, active: { type: Boolean, default: true },
    /** e.g. "Motorbike", "Bicycle", "On foot"; plate for motor vehicles; free notes (ID number, area covered). */
    vehicle: String, plate: String, notes: String,
  },
  schemaOpts,
);
export const Rider = model('Rider', riderSchema);
