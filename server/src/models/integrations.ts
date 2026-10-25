import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef } from './common';

export const INTEGRATION_KINDS = ['mpesa', 'sms', 'whatsapp', 'email', 'receipt_printer', 'kitchen_printer', 'zkteco', 'secugen', 'online_ordering', 'accounting_export'] as const;

/**
 * Per-tenant (optionally per-branch) integration configuration.
 * `settings` holds non-secret values; `secrets` holds AES-GCM ciphertext only and is never sent to clients.
 */
const integrationSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, default: null },
    kind: { type: String, enum: INTEGRATION_KINDS, required: true },
    provider: { type: String, required: true }, // daraja | talksasa | smtp | mock | escpos | zkteco | secugen
    enabled: { type: Boolean, default: false },
    environment: { type: String, enum: ['sandbox', 'production', 'mock'], default: 'sandbox' },
    settings: { type: Schema.Types.Mixed, default: {} },
    secrets: { type: Map, of: String, select: false, default: {} },
    secretHints: { type: Map, of: String, default: {} }, // masked display values, e.g. ••••a1b2
    status: {
      state: { type: String, enum: ['unconfigured', 'configured', 'ok', 'error'], default: 'unconfigured' },
      lastTestAt: Date,
      lastTestOk: Boolean,
      lastTestMessage: String,
      lastSuccessAt: Date,
      lastErrorAt: Date,
      lastError: String,
      simulated: { type: Boolean, default: false },
    },
    /** Callback tokens for providers that cannot sign requests (e.g. Daraja C2B). Stored hashed. */
    callbackKeyHash: String,
    updatedBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
integrationSchema.index({ tenantId: 1, kind: 1, branchId: 1 }, { unique: true });
export const IntegrationConfiguration = model('IntegrationConfiguration', integrationSchema);

const integrationLogSchema = new Schema(
  {
    tenantId: tenantRef,
    kind: { type: String, required: true },
    action: String,
    ok: Boolean,
    message: String,
    simulated: Boolean,
    meta: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
integrationLogSchema.index({ tenantId: 1, kind: 1, createdAt: -1 });
integrationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
export const IntegrationLog = model('IntegrationLog', integrationLogSchema);

/** A local bridge (print/biometric) running on a terminal or back-office PC. Authenticates with a hashed token. */
const bridgeAgentSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    tokenHint: String,
    lastSeenAt: Date,
    version: String,
    capabilities: [String],
    diagnostics: Schema.Types.Mixed,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
export const BridgeAgent = model('BridgeAgent', bridgeAgentSchema);

const printerSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    role: { type: String, enum: ['receipt', 'kitchen', 'bar', 'billing'], required: true },
    connection: { type: String, enum: ['network', 'usb', 'bluetooth', 'browser'], default: 'network' },
    host: String,
    port: { type: Number, default: 9100 },
    devicePath: String,
    paperWidth: { type: Number, enum: [58, 80], default: 80 },
    bridgeId: Schema.Types.ObjectId,
    opensCashDrawer: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    lastStatus: String,
    lastPrintAt: Date,
    lastError: String,
  },
  schemaOpts,
);
export const Printer = model('Printer', printerSchema);

const printJobSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, required: true },
    printerId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['receipt', 'bill', 'kitchen_ticket', 'bar_ticket', 'test', 'cash_drawer'], required: true },
    refId: Schema.Types.ObjectId,
    copy: { type: String, enum: ['original', 'duplicate'], default: 'original' },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['queued', 'sent', 'printed', 'failed'], default: 'queued', index: true },
    attempts: { type: Number, default: 0 },
    error: String,
    requestedBy: Schema.Types.ObjectId,
    dedupeKey: { type: String, required: true },
  },
  schemaOpts,
);
printJobSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
export const PrintJob = model('PrintJob', printJobSchema);

/** Commands for a bridge to execute against LAN/USB hardware (device test, clock sync, log pull, enrol/delete user). */
const bridgeCommandSchema = new Schema(
  {
    tenantId: tenantRef,
    bridgeId: { type: Schema.Types.ObjectId, required: true, index: true },
    deviceId: Schema.Types.ObjectId,
    type: { type: String, enum: ['device_test', 'sync_time', 'pull_attendance', 'enroll_user', 'delete_user', 'list_users'], required: true },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['queued', 'sent', 'done', 'failed'], default: 'queued', index: true },
    result: Schema.Types.Mixed,
    error: String,
    requestedBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
export const BridgeCommand = model('BridgeCommand', bridgeCommandSchema);
