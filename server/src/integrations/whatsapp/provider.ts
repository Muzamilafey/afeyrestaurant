import { httpJson, ProviderError, isRetryableStatus } from '../http';

export interface WhatsAppSendResult { ok: boolean; messageId?: string; status: string; raw?: unknown; simulated: boolean }
export interface WhatsAppProvider { name: string; send(to: string, text: string): Promise<WhatsAppSendResult> }

/**
 * Meta WhatsApp Cloud API: POST https://graph.facebook.com/{version}/{phoneNumberId}/messages (Bearer access token).
 *
 * Messages a business starts must use a template approved in WhatsApp Manager; free text is only allowed within 24
 * hours of the customer's last message. In "template" mode the message is sent through one generic Utility template
 * whose body has two variables — e.g. name `chili_message`, body "Message from {{1}}:\n\n{{2}}" — filled with the
 * business name and the message. Template variables may not contain new lines, tabs or more than four spaces in a
 * row, so the text is flattened for them.
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  name = 'meta';
  constructor(private cfg: { accessToken: string; phoneNumberId: string; apiVersion?: string; mode: 'template' | 'text'; templateName?: string; templateLanguage?: string; businessName: string }) {}

  async send(to: string, text: string): Promise<WhatsAppSendResult> {
    const flat = (s: string) => s.replace(/\s*\n+\s*/g, ' · ').replace(/\t/g, ' ').replace(/ {4,}/g, '   ').trim();
    const message = this.cfg.mode === 'text'
      ? { type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } }
      : {
          type: 'template',
          template: {
            name: this.cfg.templateName || 'chili_message',
            language: { code: this.cfg.templateLanguage || 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: flat(this.cfg.businessName).slice(0, 60) }, { type: 'text', text: flat(text).slice(0, 1000) }] }],
          },
        };
    const { status, body } = await httpJson(`https://graph.facebook.com/${this.cfg.apiVersion || 'v21.0'}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
    });
    const id = body?.messages?.[0]?.id as string | undefined;
    if (status < 200 || status >= 300 || !id) {
      const err = body?.error;
      const msg = err?.error_user_msg ?? err?.message ?? `HTTP ${status}`;
      // 131047 = outside the 24-hour window (use template mode); 132001 = template not found / not approved.
      throw new ProviderError(`WhatsApp: ${msg}${err?.code ? ` (code ${err.code})` : ''}`, status, body, isRetryableStatus(status) && err?.code !== 131047 && err?.code !== 132001);
    }
    return { ok: true, messageId: id, status: body?.messages?.[0]?.message_status ?? 'accepted', raw: body, simulated: false };
  }
}

/** Development stand-in: records what would be sent. */
export class MockWhatsAppProvider implements WhatsAppProvider {
  name = 'mock';
  static sent: Array<{ to: string; text: string }> = [];
  async send(to: string, text: string): Promise<WhatsAppSendResult> {
    MockWhatsAppProvider.sent.push({ to, text });
    return { ok: true, messageId: `wamid.SIM${Date.now().toString(36)}`, status: 'accepted', simulated: true };
  }
}
