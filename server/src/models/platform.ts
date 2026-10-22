import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { schemaOpts, money } from './common';

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$/ },
    customDomains: [{ type: String, lowercase: true, trim: true }],
    status: { type: String, enum: ['trial', 'active', 'suspended', 'cancelled'], default: 'trial', index: true },
    suspendedReason: String,
    contactEmail: String,
    contactPhone: String,
    kraPin: String,
    branding: {
      logoUrl: String,
      primaryColor: { type: String, default: '#07963C' },
      receiptHeader: String,
      receiptFooter: { type: String, default: 'Thank you for dining with us!' },
    },
    settings: {
      currency: { type: String, default: 'KES' },
      timezone: { type: String, default: 'Africa/Nairobi' },
      countryCode: { type: String, default: '254' },
      /** Discounts above this % require a manager approval. */
      discountApprovalThresholdBps: { type: Number, default: 1000 },
      loyaltyPointsPer100: { type: Number, default: 1 },
      loyaltyRedeemValue: { type: Number, default: 100 }, // cents per point
      costingPolicy: { type: String, enum: ['fifo', 'weighted_average'], default: 'fifo' },
      allowNegativeStock: { type: Boolean, default: false },
      mpesaTimeoutSeconds: { type: Number, default: 90 },
      offlineAllowedActions: { type: [String], default: ['browse', 'create_order', 'cash_payment', 'print'] },
      alertEmails: [String],
      alertPhones: [String],
      dailySummary: { type: Boolean, default: false },
      lowStockAlerts: { type: Boolean, default: true },
    },
  },
  schemaOpts,
);
tenantSchema.index({ customDomains: 1 });
export const Tenant = model('Tenant', tenantSchema);
export type TenantDoc = HydratedDocument<InferSchemaType<typeof tenantSchema>>;

const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    priceMonthly: money,
    priceAnnual: money,
    currency: { type: String, default: 'KES' },
    trialDays: { type: Number, default: 14 },
    limits: {
      branches: { type: Number, default: 1 },
      users: { type: Number, default: 10 },
      terminals: { type: Number, default: 2 },
      products: { type: Number, default: 500 },
    },
    features: [{ type: String }],
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
export const Plan = model('Plan', planSchema);

/** Feature flags that a plan can grant. */
export const FEATURES = [
  'pos', 'tables', 'kds', 'bar', 'inventory', 'recipes', 'procurement', 'mpesa', 'sms', 'email', 'reservations',
  'delivery', 'loyalty', 'attendance', 'biometrics', 'reports_advanced', 'multi_branch', 'offline', 'api_access',
] as const;
export type Feature = (typeof FEATURES)[number];

const subscriptionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    status: { type: String, enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled'], default: 'trialing', index: true },
    interval: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    currentPeriodStart: Date,
    currentPeriodEnd: { type: Date, index: true },
    trialEndsAt: Date,
    cancelAt: Date,
    history: {
      type: [{ at: Date, action: String, by: Schema.Types.ObjectId, note: String }],
      validate: [(v: unknown[]) => v.length <= 200, 'history too long'],
    },
  },
  schemaOpts,
);
export const Subscription = model('Subscription', subscriptionSchema);

const supportTicketSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    subject: { type: String, required: true },
    body: String,
    status: { type: String, enum: ['open', 'pending', 'closed'], default: 'open' },
    createdBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
export const SupportTicket = model('SupportTicket', supportTicketSchema);
