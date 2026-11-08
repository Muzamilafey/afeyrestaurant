import type { Types } from 'mongoose';
import { mocksAllowed } from '../config/env';
import { Tenant } from '../models';
import { loadIntegration } from '../services/integrations';
import { DarajaClient, securityCredential, type DarajaConfig } from './mpesa/daraja';
import { MetaWhatsAppProvider, MockWhatsAppProvider, type WhatsAppProvider } from './whatsapp/provider';
import { logger } from '../lib/logger';
import { MockSmsProvider, TalkSasaProvider, type SmsProvider } from './sms/provider';
import { MockEmailProvider, SmtpProvider, type EmailProvider } from './email/provider';
import { AppError } from '../lib/errors';

export class IntegrationUnavailable extends AppError {
  constructor(kind: string, message: string) {
    super(409, 'INTEGRATION_UNAVAILABLE', message, { kind });
  }
}

export async function getSmsProvider(tenantId: Types.ObjectId): Promise<{ provider: SmsProvider; settings: Record<string, any> }> {
  const cfg = await loadIntegration(tenantId, 'sms');
  if (!cfg || !cfg.enabled) throw new IntegrationUnavailable('sms', 'SMS is not enabled. Configure it under Integrations → SMS.');
  if (cfg.provider === 'mock') {
    if (!mocksAllowed) throw new IntegrationUnavailable('sms', 'The mock SMS provider is disabled in production.');
    return { provider: new MockSmsProvider(), settings: cfg.settings };
  }
  const s = cfg.settings as { baseUrl?: string; senderId?: string; sendPath?: string; balancePath?: string };
  if (!cfg.secrets.apiKey || !s.senderId) throw new IntegrationUnavailable('sms', 'Talk Sasa API key and sender ID are required.');
  return {
    provider: new TalkSasaProvider({ baseUrl: s.baseUrl || 'https://bulksms.talksasa.com/api/v3', apiKey: cfg.secrets.apiKey, senderId: s.senderId, sendPath: s.sendPath, balancePath: s.balancePath }),
    settings: cfg.settings,
  };
}

export async function getWhatsAppProvider(tenantId: Types.ObjectId): Promise<{ provider: WhatsAppProvider; settings: Record<string, any> }> {
  const cfg = await loadIntegration(tenantId, 'whatsapp');
  if (!cfg || !cfg.enabled) throw new IntegrationUnavailable('whatsapp', 'WhatsApp is not enabled. Configure it under Integrations → WhatsApp.');
  if (cfg.provider === 'mock') {
    if (!mocksAllowed) throw new IntegrationUnavailable('whatsapp', 'The simulated WhatsApp provider is disabled in production.');
    return { provider: new MockWhatsAppProvider(), settings: cfg.settings };
  }
  const s = cfg.settings as Record<string, any>;
  if (!cfg.secrets.accessToken || !s.phoneNumberId) throw new IntegrationUnavailable('whatsapp', 'WhatsApp needs the access token and the phone number ID from Meta.');
  const tenant = await Tenant.findById(tenantId).select('name').lean();
  return {
    provider: new MetaWhatsAppProvider({ accessToken: cfg.secrets.accessToken, phoneNumberId: String(s.phoneNumberId), apiVersion: s.apiVersion, mode: s.mode === 'text' ? 'text' : 'template', templateName: s.templateName, templateLanguage: s.templateLanguage, businessName: tenant?.name ?? 'Chili POS' }),
    settings: s,
  };
}

export async function getEmailProvider(tenantId: Types.ObjectId): Promise<{ provider: EmailProvider; settings: Record<string, any> }> {
  const cfg = await loadIntegration(tenantId, 'email');
  if (!cfg || !cfg.enabled) throw new IntegrationUnavailable('email', 'Email is not enabled. Configure SMTP under Integrations → Email.');
  if (cfg.provider === 'mock') {
    if (!mocksAllowed) throw new IntegrationUnavailable('email', 'The mock email provider is disabled in production.');
    return { provider: new MockEmailProvider(), settings: cfg.settings };
  }
  const s = cfg.settings as Record<string, any>;
  if (!s.host || !s.port || !s.fromEmail) throw new IntegrationUnavailable('email', 'SMTP host, port and sender email are required.');
  return {
    provider: new SmtpProvider({ host: s.host, port: Number(s.port), security: s.security ?? 'starttls', user: s.user, pass: cfg.secrets.smtpPass, fromName: s.fromName ?? 'Chili POS', fromEmail: s.fromEmail, replyTo: s.replyTo }),
    settings: s,
  };
}

export type MpesaHandle =
  | { mode: 'daraja'; client: DarajaClient; settings: Record<string, any>; environment: 'sandbox' | 'production' }
  | { mode: 'mock'; settings: Record<string, any>; environment: 'mock' };

export async function getMpesa(tenantId: Types.ObjectId, branchId: Types.ObjectId | null): Promise<MpesaHandle> {
  const cfg = await loadIntegration(tenantId, 'mpesa', branchId);
  if (!cfg || !cfg.enabled) throw new IntegrationUnavailable('mpesa', 'M-Pesa is not enabled. Configure Daraja under Integrations → M-Pesa.');
  if (cfg.provider === 'mock') {
    if (!mocksAllowed) throw new IntegrationUnavailable('mpesa', 'The simulated M-Pesa provider is disabled in production.');
    return { mode: 'mock', settings: cfg.settings, environment: 'mock' };
  }
  const s = cfg.settings as Record<string, any>;
  const missing = ['consumerKey', 'consumerSecret', 'passkey'].filter((k) => !cfg.secrets[k]);
  if (!s.shortCode) missing.push('shortCode');
  if (missing.length) throw new IntegrationUnavailable('mpesa', `M-Pesa configuration incomplete: ${missing.join(', ')}`);
  const env = cfg.environment === 'production' ? 'production' : 'sandbox';
  const dc: DarajaConfig = {
    environment: env,
    consumerKey: cfg.secrets.consumerKey,
    consumerSecret: cfg.secrets.consumerSecret,
    passkey: cfg.secrets.passkey,
    shortCode: String(s.shortCode),
    transactionType: s.transactionType === 'CustomerBuyGoodsOnline' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    partyB: s.partyB ? String(s.partyB) : undefined,
    initiatorName: s.initiatorName ? String(s.initiatorName).trim() : undefined,
    securityCredential: cfg.secrets.securityCredential || initiatorCredential(cfg.secrets.initiatorPassword, s.certificate),
  };
  return { mode: 'daraja', client: new DarajaClient(dc), settings: s, environment: env };
}

/** Encrypt the initiator password with the Safaricom certificate pasted in the settings (when no ready credential). */
function initiatorCredential(password?: string, certificate?: string) {
  if (!password || !certificate) return undefined;
  try {
    return securityCredential(password, String(certificate));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'M-Pesa: the Safaricom certificate could not be used to encrypt the initiator password');
    return undefined;
  }
}
