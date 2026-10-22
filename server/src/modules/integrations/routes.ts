import { z } from 'zod';
import { createModule, zId } from '../../http/route';
import { IntegrationConfiguration, IntegrationLog, NotificationJob, NotificationTemplate, SMSLog, EmailLog, Printer, PrintJob, BridgeAgent, BiometricDevice, INTEGRATION_KINDS, NOTIFICATION_EVENTS } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { saveIntegration, redact, recordIntegrationResult, type IntegrationKind, SECRET_KEYS } from '../../services/integrations';
import { getEmailProvider, getMpesa, getSmsProvider } from '../../integrations/factory';
import { audit } from '../../services/audit';
import { notify, retryNotification } from '../../services/notify';
import { renderTemplate, smsSegments, templateVariables } from '../../lib/template';
import { DEFAULT_TEMPLATES } from '../../services/notificationDefaults';
import { badRequest, notFound, AppError } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { env, mocksAllowed } from '../../config/env';
import { normalizeKePhone } from '../../lib/phone';

const m = createModule('/integrations', 'Integrations');

const SETUP: Record<string, string> = {
  mpesa: 'Create an app on developer.safaricom.co.ke, enable "M-Pesa Express" (and C2B for Till/Paybill confirmations), then paste the Consumer Key/Secret, Business Short Code and Lipa Na M-Pesa passkey. Use the sandbox (short code 174379) until Safaricom approves your production go-live. Callback URLs must be public HTTPS.',
  sms: 'Log in to bulksms.talksasa.com → Developers/API to create an API token. Use your approved Sender ID. Confirm the API base URL and endpoints in your Talk Sasa dashboard documentation before going live — this integration has not been verified against a live Talk Sasa account.',
  email: 'Use your provider SMTP details (Zoho: smtp.zoho.com:587 STARTTLS; Brevo: smtp-relay.brevo.com:587; Google Workspace: smtp.gmail.com:587 with an app password). Publish SPF, DKIM and DMARC records for your sending domain — see docs/integrations/email.md.',
  receipt_printer: 'Install the Chili Bridge on the till PC, then add ESC/POS printers by IP (port 9100) under Printers. Browser printing is used as a fallback.',
  kitchen_printer: 'Add kitchen/bar printers under Printers and assign them the kitchen or bar role.',
  zkteco: 'ZKTeco terminals are reached from the Chili Bridge on the same LAN (UDP/TCP 4370). Register the device under Staff → Devices. Mark it verified only after a physical test.',
  secugen: 'SecuGen USB readers require the SecuGen WebAPI / SGIBioSrv service on the Windows PC running the Chili Bridge. Enrolment and matching happen locally; only attendance events reach the cloud.',
  online_ordering: 'No external online-ordering platform is integrated. The built-in online menu is available under Delivery.',
  accounting_export: 'CSV exports are available from Reports. No external accounting system is integrated.',
};

m.route({ method: 'get', path: '', summary: 'Integration centre overview (no secrets)', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx }) => {
  const [docs, printers, bridges, devices] = await Promise.all([
    IntegrationConfiguration.find({ tenantId: ctx.tenantId }).lean(),
    Printer.find({ tenantId: ctx.tenantId }).lean(),
    BridgeAgent.find({ tenantId: ctx.tenantId }, { tokenHash: 0 }).lean(),
    BiometricDevice.find({ tenantId: ctx.tenantId }).lean(),
  ]);
  const logs = await IntegrationLog.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$kind', recent: { $push: { action: '$action', ok: '$ok', message: '$message', simulated: '$simulated', at: '$createdAt' } } } }, { $project: { recent: { $slice: ['$recent', 5] } } }]);
  return {
    mocksAllowed,
    publicApiUrl: env.PUBLIC_API_URL,
    integrations: INTEGRATION_KINDS.map((kind) => {
      const doc = docs.find((d) => d.kind === kind && !d.branchId);
      let derived: Record<string, unknown> | null = null;
      if (kind === 'receipt_printer' || kind === 'kitchen_printer') {
        const ps = printers.filter((p) => (kind === 'receipt_printer' ? ['receipt', 'billing'] : ['kitchen', 'bar']).includes(p.role));
        derived = { count: ps.length, errors: ps.filter((p) => p.lastStatus === 'error').length, lastPrintAt: ps.map((p) => p.lastPrintAt).filter(Boolean).sort().pop() ?? null, lastError: ps.find((p) => p.lastError)?.lastError ?? null };
      }
      if (kind === 'zkteco' || kind === 'secugen') {
        const ds = devices.filter((d) => d.vendor === kind);
        derived = { count: ds.length, online: ds.filter((d) => d.status === 'online').length, verified: ds.filter((d) => d.verified).length, lastSyncAt: ds.map((d) => d.lastSyncAt).filter(Boolean).sort().pop() ?? null, lastError: ds.find((d) => d.lastError)?.lastError ?? null };
      }
      return { kind, config: doc ? redact(doc as never) : null, derived, setup: SETUP[kind], secretKeys: SECRET_KEYS[kind] ?? [], recentLogs: logs.find((l) => l._id === kind)?.recent ?? [] };
    }),
    bridges,
  };
});

const zSave = z.object({
  provider: z.string().min(2).max(30), enabled: z.boolean(), environment: z.enum(['sandbox', 'production', 'mock']).optional(), branchId: zId.nullable().optional(),
  settings: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
  secrets: z.record(z.string(), z.string().max(2000).nullable()).optional(),
});
const PROVIDERS: Record<string, string[]> = { mpesa: ['daraja', 'mock'], sms: ['talksasa', 'mock'], email: ['smtp', 'mock'], online_ordering: ['none'], accounting_export: ['csv'] };

m.route({ method: 'put', path: '/:kind', summary: 'Save integration settings (secrets write-only)', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE, body: zSave }, async ({ ctx, params, body, req }) => {
  const kind = params.kind as IntegrationKind;
  if (!PROVIDERS[kind]) throw notFound('Integration');
  if (!PROVIDERS[kind].includes(body.provider)) throw badRequest(`Unsupported provider for ${kind}`);
  if (body.provider === 'mock' && !mocksAllowed) throw badRequest('Mock providers are not available in production');
  if (kind === 'mpesa' && body.provider === 'daraja') {
    const s = body.settings ?? {};
    if (s.transactionType && !['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'].includes(String(s.transactionType))) throw badRequest('Invalid transaction type');
    if (s.callbackBaseUrl && !/^https:\/\//.test(String(s.callbackBaseUrl)) && body.environment === 'production') throw badRequest('Production callback URLs must use HTTPS');
  }
  if (kind === 'email' && body.settings?.port && ![25, 465, 587, 2525].includes(Number(body.settings.port))) throw badRequest('Unusual SMTP port — use 465 (TLS) or 587 (STARTTLS)');
  if (kind === 'sms' && body.settings?.senderId && !/^[A-Za-z0-9 ]{3,11}$/.test(String(body.settings.senderId))) throw badRequest('Sender ID must be 3–11 letters/digits');
  const saved = await saveIntegration(ctx.tenantId, kind, { ...body, environment: body.provider === 'mock' ? 'mock' : body.environment, branchId: body.branchId ? (body.branchId as never) : null, settings: body.settings as Record<string, unknown> }, ctx.userId);
  // Log which secret fields changed — never their values.
  await audit(ctx, { action: `integration.${kind}_saved`, entity: 'IntegrationConfiguration', meta: { provider: body.provider, enabled: body.enabled, environment: body.environment, secretsChanged: Object.keys(body.secrets ?? {}).filter((k) => body.secrets![k]) } }, req);
  return saved;
});

m.route({ method: 'post', path: '/:kind/test', summary: 'Run a real connection test for an integration', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE, body: z.object({ to: z.string().max(120).optional() }) }, async ({ ctx, params, body, req }) => {
  const kind = params.kind as IntegrationKind;
  let result: { ok: boolean; message: string; simulated?: boolean; detail?: unknown };
  try {
    if (kind === 'mpesa') {
      const mp = await getMpesa(ctx.tenantId, null);
      if (mp.mode === 'mock') result = { ok: true, simulated: true, message: 'SIMULATED provider — no request was sent to Safaricom.' };
      else {
        await mp.client.accessToken();
        result = { ok: true, message: `Authenticated with Daraja ${mp.environment}. STK Push itself is verified on the first real payment.` };
      }
    } else if (kind === 'sms') {
      const to = body.to ? normalizeKePhone(body.to) : null;
      if (!to) throw badRequest('Enter a valid phone number to receive the test SMS');
      const { provider } = await getSmsProvider(ctx.tenantId);
      const r = await provider.send(to, renderTemplate(DEFAULT_TEMPLATES.test.sms!, { restaurant_name: 'Chili POS' }).text);
      let balance: string | undefined;
      try {
        balance = (await provider.balance?.())?.balance;
      } catch {
        /* balance endpoint optional */
      }
      result = { ok: true, simulated: r.simulated, message: r.simulated ? 'SIMULATED send — no SMS left this server.' : `Submitted to Talk Sasa (id ${r.messageId ?? 'n/a'}, status ${r.status}). Delivery is confirmed by the delivery report, not by this test.`, detail: { balance } };
    } else if (kind === 'email') {
      if (!body.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) throw badRequest('Enter a test recipient email');
      const { provider } = await getEmailProvider(ctx.tenantId);
      await provider.verify();
      const r = await provider.send({ to: body.to, subject: 'Chili POS test email', text: 'This is a test email from Chili POS. Your SMTP integration is working.' });
      result = { ok: r.status === 'accepted', simulated: r.simulated, message: r.simulated ? 'SIMULATED send (development transport).' : `Accepted by the SMTP server (message id ${r.messageId}). Acceptance is not proof of inbox delivery.` };
    } else {
      throw badRequest('Use the printer / device test actions for this integration');
    }
  } catch (e) {
    result = { ok: false, message: (e as Error).message };
  }
  await recordIntegrationResult(ctx.tenantId, kind, { ok: result.ok, action: 'test', message: result.message, simulated: result.simulated, isTest: true });
  await audit(ctx, { action: `integration.${kind}_tested`, meta: { ok: result.ok, simulated: result.simulated } }, req);
  return result;
});

m.route({ method: 'get', path: '/:kind/logs', summary: 'Recent integration log entries', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx, params }) => IntegrationLog.find({ tenantId: ctx.tenantId, kind: params.kind }).sort({ createdAt: -1 }).limit(100).lean());

// ── Notifications: queue, logs, retry, templates ──
m.route({ method: 'get', path: '/notifications/jobs', summary: 'Notification queue and history', auth: 'tenant', permission: [P.NOTIFICATIONS_MANAGE, P.INTEGRATIONS_MANAGE], query: z.object({ channel: z.enum(['sms', 'email']).optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (query.channel) f.channel = query.channel;
  if (query.status) f.status = { $in: query.status.split(',') };
  return NotificationJob.find(f, { html: 0, attachments: 0 }).sort({ createdAt: -1 }).limit(200).lean();
});
m.route({ method: 'post', path: '/notifications/jobs/:id/retry', summary: 'Retry a failed notification', auth: 'tenant', permission: [P.NOTIFICATIONS_MANAGE, P.INTEGRATIONS_MANAGE] }, async ({ ctx, params, req }) => {
  const j = await retryNotification(ctx.tenantId, params.id as never);
  if (!j) throw notFound('Failed notification');
  await audit(ctx, { action: 'notification.retry', entity: 'NotificationJob', entityId: j._id }, req);
  return j;
});
m.route({ method: 'get', path: '/notifications/logs', summary: 'SMS and email provider logs', auth: 'tenant', permission: [P.NOTIFICATIONS_MANAGE, P.INTEGRATIONS_MANAGE] }, async ({ ctx }) => ({
  sms: await SMSLog.find({ tenantId: ctx.tenantId }, { response: 0 }).sort({ createdAt: -1 }).limit(100).lean(),
  email: await EmailLog.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).limit(100).lean(),
}));
m.route({ method: 'get', path: '/notifications/templates', summary: 'Templates (custom + defaults)', auth: 'tenant', permission: P.NOTIFICATIONS_MANAGE }, async ({ ctx }) => {
  const custom = await NotificationTemplate.find({ tenantId: ctx.tenantId }).lean();
  return NOTIFICATION_EVENTS.flatMap((event) => (['sms', 'email'] as const).map((channel) => {
    const c = custom.find((t) => t.event === event && t.channel === channel);
    const d = DEFAULT_TEMPLATES[event];
    const def = channel === 'sms' ? d?.sms : d?.email?.body;
    if (!c && !def) return null;
    const body = c?.body ?? def!;
    return { event, channel, custom: !!c, enabled: c?.enabled ?? true, subject: c?.subject ?? d?.email?.subject, body, variables: templateVariables(body + (c?.subject ?? d?.email?.subject ?? '')), segments: channel === 'sms' ? smsSegments(body) : undefined, marketing: event === 'promotion' };
  }).filter(Boolean));
});
m.route({ method: 'put', path: '/notifications/templates/:event/:channel', summary: 'Customise a template', auth: 'tenant', permission: P.NOTIFICATIONS_MANAGE, body: z.object({ subject: z.string().max(200).optional(), body: z.string().min(1).max(5000), enabled: z.boolean().default(true) }) }, async ({ ctx, params, body }) => {
  if (!NOTIFICATION_EVENTS.includes(params.event as never) || !['sms', 'email'].includes(params.channel)) throw notFound('Template');
  if (params.channel === 'sms' && smsSegments(body.body).segments > 6) throw badRequest('SMS template exceeds 6 segments');
  return NotificationTemplate.findOneAndUpdate({ tenantId: ctx.tenantId, event: params.event, channel: params.channel }, { $set: body }, { upsert: true, new: true });
});
m.route({ method: 'post', path: '/notifications/send', summary: 'Queue a one-off notification (e.g. promotion to an opted-in customer)', auth: 'tenant', permission: P.NOTIFICATIONS_MANAGE, body: z.object({ event: z.enum(NOTIFICATION_EVENTS), channel: z.enum(['sms', 'email']), to: z.string().min(5).max(120), vars: z.record(z.string(), z.string().max(500)).default({}), customerId: zId.optional() }) }, async ({ ctx, body }) =>
  notify(ctx.tenantId, { ...body, customerId: body.customerId as never, dedupeKey: `manual:${ctx.userId}:${Date.now()}` }),
);

/** Talk Sasa delivery reports. The payload shape is not documented publicly, so common field names are accepted and the raw body is stored. */
m.route({ method: 'post', path: '/webhooks/sms/:tenantId/:key', summary: 'SMS delivery report webhook (public, key-authenticated)', auth: 'public', raw: true }, async ({ params, body, res }) => {
  const integ = await IntegrationConfiguration.findOne({ tenantId: params.tenantId, kind: 'sms' }).lean().catch(() => null);
  const expected = (integ?.settings as Record<string, string> | undefined)?.webhookKeyHash;
  if (!integ || !expected || expected !== sha256(params.key)) throw notFound('Webhook');
  const b = body as Record<string, unknown>;
  const id = String(b.uid ?? b.message_id ?? b.messageId ?? b.id ?? '');
  const status = String(b.status ?? b.delivery_status ?? 'unknown');
  if (id) {
    await SMSLog.updateMany({ tenantId: integ.tenantId, providerMessageId: id }, { $set: { providerStatus: status } });
    if (/deliver/i.test(status)) await NotificationJob.updateOne({ tenantId: integ.tenantId, providerMessageId: id }, { $set: { status: 'delivered' } });
  }
  res.json({ ok: true });
});
m.route({ method: 'post', path: '/sms/webhook-key', summary: 'Generate the SMS delivery-report webhook URL', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx }) => {
  const integ = await IntegrationConfiguration.findOne({ tenantId: ctx.tenantId, kind: 'sms', branchId: null });
  if (!integ) throw notFound('SMS configuration');
  const key = randomToken(24);
  integ.settings = { ...(integ.settings as object), webhookKeyHash: sha256(key) };
  integ.markModified('settings');
  await integ.save();
  return { url: `${env.PUBLIC_API_URL}/api/v1/integrations/webhooks/sms/${ctx.tenantId}/${key}`, note: 'Shown once. Paste it into your Talk Sasa delivery-report settings.' };
});
m.route({ method: 'get', path: '/sms/balance', summary: 'SMS balance from the provider (if supported)', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx }) => {
  const { provider } = await getSmsProvider(ctx.tenantId);
  if (!provider.balance) throw new AppError(501, 'UNSUPPORTED', 'Provider does not expose a balance');
  return provider.balance();
});

// ── Bridges (local print/biometric agents) ──
m.route({ method: 'post', path: '/bridges', summary: 'Register a local bridge — returns its token once', permission: P.INTEGRATIONS_MANAGE, body: z.object({ name: z.string().min(2).max(60) }), status: 201 }, async ({ ctx, body, req }) => {
  const token = `cbr_${randomToken(32)}`;
  const b = await BridgeAgent.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, name: body.name, tokenHash: sha256(token), tokenHint: token.slice(-4) });
  await audit(ctx, { action: 'bridge.registered', entity: 'BridgeAgent', entityId: b._id }, req);
  return { id: b._id, name: b.name, token, apiUrl: env.PUBLIC_API_URL, note: 'Copy this token into the bridge configuration now. It will not be shown again.' };
});
m.route({ method: 'post', path: '/bridges/:id/revoke', summary: 'Revoke a bridge', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx, params, req }) => {
  const b = await BridgeAgent.findOneAndUpdate({ tenantId: ctx.tenantId, _id: params.id }, { $set: { active: false } }, { new: true, projection: { tokenHash: 0 } });
  if (!b) throw notFound('Bridge');
  await audit(ctx, { action: 'bridge.revoked', entity: 'BridgeAgent', entityId: b._id }, req);
  return b;
});

// ── Printers ──
const zPrinter = z.object({ name: z.string().min(1).max(60), role: z.enum(['receipt', 'kitchen', 'bar', 'billing']), connection: z.enum(['network', 'usb', 'bluetooth', 'browser']), host: z.string().max(100).optional(), port: z.number().int().min(1).max(65535).optional(), devicePath: z.string().max(200).optional(), paperWidth: z.union([z.literal(58), z.literal(80)]).optional(), bridgeId: zId.optional(), opensCashDrawer: z.boolean().optional(), active: z.boolean().optional() });
m.route({ method: 'get', path: '/printers', summary: 'Printers for the branch', permission: [P.INTEGRATIONS_MANAGE, P.ORDERS_VIEW] }, async ({ ctx }) => Printer.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/printers', summary: 'Add a printer', permission: P.INTEGRATIONS_MANAGE, body: zPrinter, status: 201 }, async ({ ctx, body }) => {
  if (body.connection !== 'browser' && !body.bridgeId) throw badRequest('Network/USB/Bluetooth printers are driven by a bridge — select one');
  return Printer.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId });
});
m.route({ method: 'patch', path: '/printers/:id', summary: 'Update a printer', permission: P.INTEGRATIONS_MANAGE, body: zPrinter.partial() }, async ({ ctx, params, body }) => {
  const p = await Printer.findOneAndUpdate({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $set: body }, { new: true });
  if (!p) throw notFound('Printer');
  return p;
});
/** Queue a print job for a bridge printer. Jobs are idempotent per dedupeKey; failures never affect the sale. */
m.route({ method: 'post', path: '/printers/:id/jobs', summary: 'Queue a print job (test, receipt, ticket, open drawer)', permission: P.ORDERS_VIEW, body: z.object({ kind: z.enum(['receipt', 'bill', 'kitchen_ticket', 'bar_ticket', 'test', 'cash_drawer']), refId: zId.optional(), copy: z.enum(['original', 'duplicate']).optional(), payload: z.unknown().optional(), dedupeKey: z.string().min(6).max(100) }), status: 201 }, async ({ ctx, params, body }) => {
  const p = await Printer.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id, active: true }).lean();
  if (!p) throw notFound('Printer');
  const existing = await PrintJob.findOne({ tenantId: ctx.tenantId, dedupeKey: body.dedupeKey }).lean();
  if (existing) return existing;
  return PrintJob.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, printerId: p._id, kind: body.kind, refId: body.refId, copy: body.copy ?? 'original', payload: body.payload, requestedBy: ctx.userId, dedupeKey: body.dedupeKey });
});
m.route({ method: 'get', path: '/print-jobs', summary: 'Print log', permission: [P.INTEGRATIONS_MANAGE, P.ORDERS_VIEW] }, async ({ ctx }) => PrintJob.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }, { payload: 0 }).sort({ createdAt: -1 }).limit(200).lean());

export default m;
