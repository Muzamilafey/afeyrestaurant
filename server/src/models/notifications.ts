import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef } from './common';

export const NOTIFICATION_EVENTS = [
  'payment_confirmation', 'mpesa_receipt', 'order_confirmation', 'order_ready', 'delivery_update', 'reservation_confirmation',
  'reservation_reminder', 'reservation_cancellation', 'loyalty_points', 'promotion', 'manager_sales_summary', 'low_stock_alert',
  'staff_attendance', 'subscription_expiry', 'integration_failure', 'receipt', 'invoice', 'purchase_order', 'supplier_payment',
  'password_reset', 'login_alert', 'report_export', 'test',
] as const;
/** Promotional events require opt-in consent; all others are transactional. */
export const MARKETING_EVENTS = new Set(['promotion']);

const templateSchema = new Schema(
  {
    tenantId: tenantRef,
    event: { type: String, enum: NOTIFICATION_EVENTS, required: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    subject: String,
    body: { type: String, required: true, maxlength: 10000 },
    html: String,
    enabled: { type: Boolean, default: true },
  },
  schemaOpts,
);
templateSchema.index({ tenantId: 1, event: 1, channel: 1 }, { unique: true });
export const NotificationTemplate = model('NotificationTemplate', templateSchema);

/** A queued notification. Processed by the background worker with retries and dedupe. */
const notificationJobSchema = new Schema(
  {
    tenantId: tenantRef,
    channel: { type: String, enum: ['sms', 'email'], required: true },
    event: { type: String, required: true },
    to: { type: String, required: true },
    subject: String,
    body: { type: String, required: true },
    html: String,
    attachments: [{ filename: String, contentType: String, content: String }],
    status: { type: String, enum: ['queued', 'sending', 'sent', 'delivered', 'failed', 'dead', 'skipped'], default: 'queued', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lastError: String,
    providerMessageId: String,
    dedupeKey: { type: String, required: true },
    refType: String,
    refId: Schema.Types.ObjectId,
  },
  schemaOpts,
);
notificationJobSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
notificationJobSchema.index({ status: 1, runAt: 1 });
export const NotificationJob = model('NotificationJob', notificationJobSchema);

const smsLogSchema = new Schema(
  {
    tenantId: tenantRef,
    jobId: Schema.Types.ObjectId,
    to: String,
    provider: String,
    segments: Number,
    status: String,
    providerMessageId: { type: String, index: true },
    providerStatus: String,
    cost: String,
    error: String,
    simulated: { type: Boolean, default: false },
    response: Schema.Types.Mixed,
  },
  schemaOpts,
);
export const SMSLog = model('SMSLog', smsLogSchema);

const emailLogSchema = new Schema(
  {
    tenantId: tenantRef,
    jobId: Schema.Types.ObjectId,
    to: String,
    subject: String,
    status: { type: String, enum: ['accepted', 'rejected', 'failed'] },
    messageId: String,
    response: String,
    error: String,
    simulated: { type: Boolean, default: false },
  },
  schemaOpts,
);
export const EmailLog = model('EmailLog', emailLogSchema);
