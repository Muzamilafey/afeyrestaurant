import type { Types } from 'mongoose';
import { NotificationJob, NotificationTemplate, Tenant, SMSLog, EmailLog, Customer, MARKETING_EVENTS, IntegrationConfiguration } from '../models';
import { renderTemplate, smsSegments } from '../lib/template';
import { normalizeKePhone } from '../lib/phone';
import { DEFAULT_TEMPLATES } from './notificationDefaults';
import { getEmailProvider, getSmsProvider, getWhatsAppProvider, IntegrationUnavailable } from '../integrations/factory';
import { ProviderError } from '../integrations/http';
import { recordIntegrationResult } from './integrations';
import { logger } from '../lib/logger';

export interface NotifyInput {
  event: string;
  channel: 'sms' | 'email' | 'whatsapp';
  to: string;
  vars: Record<string, unknown>;
  /** Unique key: the same logical notification is never queued twice. */
  dedupeKey: string;
  refType?: string;
  refId?: Types.ObjectId;
  /** Required for marketing events — the customer whose consent is checked. */
  customerId?: Types.ObjectId;
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
  runAt?: Date;
}

const MAX_SMS_SEGMENTS = 6;

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Branded HTML wrapper with a plain-text alternative. Variables are HTML-escaped. */
export function emailHtml(brand: { name: string; color?: string; logoUrl?: string }, bodyText: string) {
  const color = /^#[0-9a-f]{6}$/i.test(brand.color ?? '') ? brand.color : '#07963C';
  const paragraphs = escapeHtml(bodyText)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#F3F5F4;font-family:Inter,Segoe UI,Arial,sans-serif;color:#171A18">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #E4E8E5;border-radius:14px;overflow:hidden">
<tr><td style="background:${color};padding:18px 24px;color:#fff;font-weight:700;font-size:18px">${escapeHtml(brand.name)}</td></tr>
<tr><td style="padding:24px;font-size:14px">${paragraphs}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #E4E8E5;color:#737A75;font-size:12px">Sent by ${escapeHtml(brand.name)} via Chili POS</td></tr>
</table></td></tr></table></body></html>`;
}

/** Queue a notification. Returns the job (existing job if the dedupe key was already used). */
/** Messages for staff/management — never redirected to the customer WhatsApp channel. */
const INTERNAL_EVENTS = new Set(['manager_sales_summary', 'low_stock_alert', 'integration_failure', 'staff_attendance', 'subscription_expiry', 'test', 'password_reset', 'login_alert']);

export async function notify(tenantId: Types.ObjectId, input: NotifyInput) {
  // Customer SMS can go by WhatsApp instead of, or as well as, SMS (Integrations → WhatsApp → "Use for customer messages").
  if (input.channel === 'sms' && !INTERNAL_EVENTS.has(input.event)) {
    const wa = await IntegrationConfiguration.findOne({ tenantId, kind: 'whatsapp', enabled: true }, { settings: 1 }).lean();
    const useFor = (wa?.settings as Record<string, unknown> | undefined)?.useFor;
    if (wa && (useFor === 'instead_of_sms' || useFor === 'with_sms')) {
      const waJob = await queueNotification(tenantId, { ...input, channel: 'whatsapp', dedupeKey: `${input.dedupeKey}:wa` });
      if (useFor === 'instead_of_sms') return waJob;
    }
  }
  return queueNotification(tenantId, input);
}

async function queueNotification(tenantId: Types.ObjectId, input: NotifyInput) {
  const existing = await NotificationJob.findOne({ tenantId, dedupeKey: input.dedupeKey }).lean();
  if (existing) return existing;
  const tenant = await Tenant.findById(tenantId).lean();
  const vars = { restaurant_name: tenant?.name, ...input.vars };
  let to = input.to.trim();
  let skipReason: string | null = null;

  if (MARKETING_EVENTS.has(input.event)) {
    const c = input.customerId ? await Customer.findOne({ tenantId, _id: input.customerId }).lean() : null;
    const ok = input.channel === 'sms' ? c?.consent?.marketingSms : c?.consent?.marketingEmail;
    if (!ok) skipReason = 'Customer has not opted in to marketing messages';
  }
  if (input.channel === 'sms' || input.channel === 'whatsapp') {
    const n = normalizeKePhone(to, tenant?.settings?.countryCode ?? '254');
    if (!n) skipReason = `Invalid phone number: ${to}`;
    else to = n;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) skipReason = `Invalid email address: ${to}`;

  const custom = await NotificationTemplate.findOne({ tenantId, event: input.event, channel: input.channel }).lean();
  if (custom && !custom.enabled) skipReason ??= 'Template disabled';
  const def = DEFAULT_TEMPLATES[input.event];
  // WhatsApp has room for the longer email text (e.g. the full receipt), else the SMS text.
  const bodyTpl = custom?.body ?? (input.channel === 'sms' ? def?.sms : input.channel === 'whatsapp' ? def?.email?.body ?? def?.sms : def?.email?.body);
  const subjectTpl = custom?.subject ?? def?.email?.subject;
  if (!bodyTpl) skipReason ??= `No ${input.channel} template for ${input.event}`;
  const body = bodyTpl ? renderTemplate(bodyTpl, vars).text : '(none)';
  const subject = subjectTpl ? renderTemplate(subjectTpl, vars).text : undefined;
  if (input.channel === 'sms' && smsSegments(body).segments > MAX_SMS_SEGMENTS) skipReason ??= `Message too long (${smsSegments(body).segments} segments)`;

  if (!skipReason) {
    const integ = await IntegrationConfiguration.findOne({ tenantId, kind: input.channel, enabled: true }, { _id: 1 }).lean();
    if (!integ) skipReason = `${input.channel.toUpperCase()} integration is not enabled`;
  }
  const html = input.channel === 'email' ? emailHtml({ name: tenant?.name ?? 'Chili POS', color: tenant?.branding?.primaryColor ?? undefined }, body) : undefined;
  try {
    return await NotificationJob.create({
      tenantId, channel: input.channel, event: input.event, to, subject, body, html, attachments: input.attachments,
      dedupeKey: input.dedupeKey, refType: input.refType, refId: input.refId, runAt: input.runAt ?? new Date(),
      status: skipReason ? 'skipped' : 'queued', lastError: skipReason ?? undefined,
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return NotificationJob.findOne({ tenantId, dedupeKey: input.dedupeKey }).lean();
    throw e;
  }
}

const backoffMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1));

/** Deliver one claimed job. */
async function deliver(job: InstanceType<typeof NotificationJob>) {
  const tenantId = job.tenantId as Types.ObjectId;
  try {
    if (job.channel === 'sms') {
      const { provider } = await getSmsProvider(tenantId);
      const r = await provider.send(job.to, job.body);
      await SMSLog.create({ tenantId, jobId: job._id, to: job.to, provider: provider.name, segments: smsSegments(job.body).segments, status: r.status, providerMessageId: r.messageId, cost: r.cost, simulated: r.simulated, response: r.raw });
      job.status = 'sent';
      job.providerMessageId = r.messageId;
      await recordIntegrationResult(tenantId, 'sms', { ok: true, action: `send:${job.event}`, message: r.simulated ? 'Simulated send' : `Submitted (${r.messageId ?? 'no id'})`, simulated: r.simulated, isTest: job.event === 'test' });
    } else if (job.channel === 'whatsapp') {
      const { provider } = await getWhatsAppProvider(tenantId);
      const r = await provider.send(job.to, job.subject ? `${job.subject}\n\n${job.body}` : job.body);
      job.status = 'sent';
      job.providerMessageId = r.messageId;
      await recordIntegrationResult(tenantId, 'whatsapp', { ok: true, action: `send:${job.event}`, message: r.simulated ? 'Simulated send' : `Accepted by WhatsApp (${r.messageId})`, simulated: r.simulated, isTest: job.event === 'test' });
    } else {
      const { provider } = await getEmailProvider(tenantId);
      const r = await provider.send({ to: job.to, subject: job.subject ?? '(no subject)', text: job.body, html: job.html ?? undefined, attachments: job.attachments?.map((a) => ({ filename: a.filename!, content: a.content!, contentType: a.contentType ?? undefined })) });
      await EmailLog.create({ tenantId, jobId: job._id, to: job.to, subject: job.subject, status: r.status, messageId: r.messageId, response: r.response, simulated: r.simulated });
      if (r.status === 'rejected') throw new ProviderError('Recipient rejected by SMTP server', 550, undefined, false);
      job.status = 'sent';
      job.providerMessageId = r.messageId;
      await recordIntegrationResult(tenantId, 'email', { ok: true, action: `send:${job.event}`, message: r.simulated ? 'Simulated send' : `Accepted by SMTP server (${r.messageId})`, simulated: r.simulated, isTest: job.event === 'test' });
    }
    job.lastError = undefined;
  } catch (e) {
    const retryable = e instanceof IntegrationUnavailable ? false : e instanceof ProviderError ? e.retryable : true;
    job.lastError = (e as Error).message.slice(0, 500);
    if (job.channel === 'sms') await SMSLog.create({ tenantId, jobId: job._id, to: job.to, status: 'failed', error: job.lastError });
    else if (job.channel === 'email') await EmailLog.create({ tenantId, jobId: job._id, to: job.to, subject: job.subject, status: 'failed', error: job.lastError });
    await recordIntegrationResult(tenantId, job.channel as 'sms' | 'email' | 'whatsapp', { ok: false, action: `send:${job.event}`, message: job.lastError, isTest: job.event === 'test' });
    if (retryable && job.attempts < job.maxAttempts) {
      job.status = 'queued';
      job.runAt = new Date(Date.now() + backoffMs(job.attempts));
    } else {
      job.status = retryable ? 'dead' : 'failed';
    }
  }
  job.lockedAt = undefined;
  await job.save();
}

/** Claim and process due notification jobs. Safe to run in several worker processes. */
export async function processNotificationQueue(limit = 20) {
  // A job stuck in "sending" means a worker died mid-send. The outcome is unknown, so we do not resend
  // automatically (that could duplicate the message) — it is marked failed for a manual retry.
  await NotificationJob.updateMany(
    { status: 'sending', lockedAt: { $lt: new Date(Date.now() - 5 * 60_000) } },
    { $set: { status: 'failed', lastError: 'Delivery outcome unknown (worker interrupted). Retry manually if the message was not received.' }, $unset: { lockedAt: 1 } },
  ).setOptions({ skipTenantGuard: true });
  let processed = 0;
  for (; processed < limit; processed++) {
    const job = await NotificationJob.findOneAndUpdate(
      { status: 'queued', runAt: { $lte: new Date() } },
      { $set: { status: 'sending', lockedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true, sort: { runAt: 1 } },
    ).setOptions({ skipTenantGuard: true });
    if (!job) break;
    await deliver(job).catch((e) => logger.error({ err: e, jobId: job._id }, 'Notification delivery crashed'));
  }
  return processed;
}

/** Manually retry a failed/dead job (does not reset dedupe — same logical message). */
export async function retryNotification(tenantId: Types.ObjectId, id: Types.ObjectId) {
  return NotificationJob.findOneAndUpdate(
    { tenantId, _id: id, status: { $in: ['failed', 'dead'] } },
    { $set: { status: 'queued', runAt: new Date(), attempts: 0 }, $unset: { lastError: 1 } },
    { new: true },
  );
}
