import { httpJson, ProviderError, isRetryableStatus } from '../http';

export interface SmsSendResult {
  ok: boolean;
  messageId?: string;
  status: string;
  cost?: string;
  raw?: unknown;
  simulated: boolean;
}
export interface SmsProvider {
  name: string;
  send(to: string, message: string): Promise<SmsSendResult>;
  balance?(): Promise<{ balance: string; raw: unknown }>;
}

/**
 * Talk Sasa bulk SMS (https://bulksms.talksasa.com). API v3 with Bearer token authentication:
 *   POST {baseUrl}/sms/send   { recipient, sender_id, type: "plain", message }
 *   GET  {baseUrl}/balance
 * Endpoint paths are configurable because the provider's official documentation must be confirmed from the
 * account dashboard before production use. Status: UNVERIFIED against a live account.
 */
export class TalkSasaProvider implements SmsProvider {
  name = 'talksasa';
  constructor(private cfg: { baseUrl: string; apiKey: string; senderId: string; sendPath?: string; balancePath?: string }) {}

  private url(path: string) {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  async send(to: string, message: string): Promise<SmsSendResult> {
    const { status, body } = await httpJson(this.url(this.cfg.sendPath ?? 'sms/send'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ recipient: to, sender_id: this.cfg.senderId, type: 'plain', message }),
    });
    const success = status >= 200 && status < 300 && (body?.status === 'success' || body?.status === true);
    if (!success) {
      const msg = body?.message ?? body?.error ?? `HTTP ${status}`;
      throw new ProviderError(`Talk Sasa rejected the message: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, status, body, isRetryableStatus(status));
    }
    const data = body?.data ?? {};
    return { ok: true, messageId: data.uid ?? data.message_id ?? data.id ?? undefined, status: data.status ?? 'submitted', cost: data.cost ? String(data.cost) : undefined, raw: body, simulated: false };
  }

  async balance() {
    const { status, body } = await httpJson(this.url(this.cfg.balancePath ?? 'balance'), { headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' } });
    if (status !== 200) throw new ProviderError(`Balance request failed: HTTP ${status}`, status, body, isRetryableStatus(status));
    const d = body?.data ?? body;
    return { balance: String(d?.remaining_balance ?? d?.balance ?? d?.remaining_unit ?? JSON.stringify(d)), raw: body };
  }
}

/** Development/test-only provider. Results are clearly flagged as simulated. Never available in production. */
export class MockSmsProvider implements SmsProvider {
  name = 'mock';
  static sent: Array<{ to: string; message: string }> = [];
  async send(to: string, message: string): Promise<SmsSendResult> {
    if (to.endsWith('000000')) throw new ProviderError('Simulated permanent failure', 400, undefined, false);
    MockSmsProvider.sent.push({ to, message });
    return { ok: true, messageId: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'simulated', simulated: true };
  }
  async balance() {
    return { balance: 'SIMULATED', raw: null };
  }
}
