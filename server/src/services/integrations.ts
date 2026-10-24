import type { Types } from 'mongoose';
import { IntegrationConfiguration, IntegrationLog, INTEGRATION_KINDS } from '../models';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto';
import { logger } from '../lib/logger';

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Which settings keys are secrets for each integration. Secrets are encrypted and never returned. */
export const SECRET_KEYS: Record<string, string[]> = {
  mpesa: ['consumerKey', 'consumerSecret', 'passkey', 'initiatorPassword', 'securityCredential'],
  sms: ['apiKey'],
  email: ['smtpPass'],
  online_ordering: ['apiKey'],
  accounting_export: ['apiKey'],
};

export interface LoadedIntegration {
  id: Types.ObjectId;
  enabled: boolean;
  provider: string;
  environment: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

export async function loadIntegration(tenantId: Types.ObjectId, kind: IntegrationKind, branchId: Types.ObjectId | null = null): Promise<LoadedIntegration | null> {
  // Branch-specific configuration takes precedence over the tenant-wide one.
  const docs = await IntegrationConfiguration.find({ tenantId, kind, branchId: { $in: branchId ? [branchId, null] : [null] } }).select('+secrets').lean();
  const doc = docs.find((d) => branchId && String(d.branchId) === String(branchId)) ?? docs.find((d) => !d.branchId);
  if (!doc) return null;
  const secrets: Record<string, string> = {};
  const raw = (doc.secrets ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(raw instanceof Map ? Object.fromEntries(raw) : raw)) {
    try {
      secrets[k] = decryptSecret(v as string);
    } catch (e) {
      logger.error({ kind, key: k, tenantId }, 'Failed to decrypt integration secret');
    }
  }
  return { id: doc._id, enabled: !!doc.enabled, provider: doc.provider, environment: doc.environment ?? 'sandbox', settings: (doc.settings ?? {}) as Record<string, unknown>, secrets };
}

export async function saveIntegration(
  tenantId: Types.ObjectId,
  kind: IntegrationKind,
  input: { enabled?: boolean; provider: string; environment?: string; settings?: Record<string, unknown>; secrets?: Record<string, string | null | undefined>; branchId?: Types.ObjectId | null },
  by: Types.ObjectId,
) {
  const branchId = input.branchId ?? null;
  let doc = await IntegrationConfiguration.findOne({ tenantId, kind, branchId }).select('+secrets');
  if (!doc) doc = new IntegrationConfiguration({ tenantId, kind, branchId, provider: input.provider });
  doc.provider = input.provider;
  if (input.enabled !== undefined) doc.enabled = input.enabled;
  if (input.environment) doc.set('environment', input.environment);
  if (input.settings) {
    const keep = (doc.settings as Record<string, unknown> | undefined)?.webhookKeyHash;
    doc.settings = { ...input.settings, ...(keep ? { webhookKeyHash: keep } : {}) };
  }
  const allowed = SECRET_KEYS[kind] ?? [];
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    if (!allowed.includes(k)) continue;
    if (v === null) {
      doc.secrets!.delete(k);
      doc.secretHints!.delete(k);
    } else if (v) {
      // Empty strings mean "unchanged" — the UI never receives the existing value.
      doc.secrets!.set(k, encryptSecret(v));
      doc.secretHints!.set(k, maskSecret(v)!);
    }
  }
  doc.updatedBy = by;
  doc.set('status.state', doc.enabled ? 'configured' : 'unconfigured');
  // A configuration change invalidates any previous successful test.
  doc.set('status.lastTestOk', undefined);
  await doc.save();
  return redact(doc.toObject());
}

/** Public view of an integration — secrets replaced by "configured" flags and masked hints. */
export function redact(doc: Record<string, any>) {
  const hints = doc.secretHints instanceof Map ? Object.fromEntries(doc.secretHints) : (doc.secretHints ?? {});
  const { secrets: _s, callbackKeyHash: _c, ...rest } = doc;
  const { webhookKeyHash: _w, ...settings } = (doc.settings ?? {}) as Record<string, unknown>;
  return { ...rest, settings, secretHints: hints, secretsConfigured: Object.keys(hints), c2bRegistered: !!_c, smsWebhookConfigured: !!_w };
}

export async function recordIntegrationResult(
  tenantId: Types.ObjectId,
  kind: IntegrationKind,
  r: { ok: boolean; action: string; message: string; simulated?: boolean; meta?: unknown; isTest?: boolean },
) {
  const now = new Date();
  const set: Record<string, unknown> = r.ok
    ? { 'status.lastSuccessAt': now, 'status.state': r.simulated ? 'configured' : 'ok', 'status.simulated': !!r.simulated }
    : { 'status.lastErrorAt': now, 'status.lastError': r.message.slice(0, 500), 'status.state': 'error' };
  if (r.isTest) Object.assign(set, { 'status.lastTestAt': now, 'status.lastTestOk': r.ok && !r.simulated, 'status.lastTestMessage': r.message.slice(0, 500) });
  await IntegrationConfiguration.updateMany({ tenantId, kind }, { $set: set });
  await IntegrationLog.create({ tenantId, kind, action: r.action, ok: r.ok, message: r.message.slice(0, 1000), simulated: !!r.simulated, meta: r.meta });
}
