import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { schemaOpts } from './common';

/**
 * The business (restaurant / bar) this installation serves. Chili POS is single-tenant: there is exactly one
 * business document per deployment. Internally records still carry its id (`tenantId`) as a scoping key so the
 * query guard keeps every lookup explicit.
 */
const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Guarantees a single business document per installation. */
    singleton: { type: String, default: 'business', unique: true, immutable: true },
    /** Set in the same transaction that creates the branch, roles, owner and taxes — first-run setup is complete. */
    setupCompletedAt: Date,
    contactEmail: String,
    contactPhone: String,
    kraPin: String,
    branding: {
      logoUrl: String,
      /** PNG app icons generated from the logo (browser tab, home screen, installed app); source = the logo they came from. */
      appIcons: { icon192: String, icon512: String, maskable512: String, source: String },
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
export const Tenant = model('Tenant', tenantSchema);
export type TenantDoc = HydratedDocument<InferSchemaType<typeof tenantSchema>>;

/** Preferred name in application code; the collection keeps its original name for data compatibility. */
export const Business = Tenant;
