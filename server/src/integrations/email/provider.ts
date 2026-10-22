import nodemailer, { type Transporter } from 'nodemailer';
import { ProviderError } from '../http';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}
export interface EmailSendResult {
  /** "accepted" means the SMTP server accepted the message — not confirmed inbox delivery. */
  status: 'accepted' | 'rejected';
  messageId?: string;
  response?: string;
  simulated: boolean;
}
export interface EmailProvider {
  name: string;
  verify(): Promise<void>;
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user?: string;
  pass?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
}

export class SmtpProvider implements EmailProvider {
  name = 'smtp';
  private transport: Transporter;
  constructor(private cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === 'tls', // implicit TLS (465)
      requireTLS: cfg.security === 'starttls', // refuse to send if STARTTLS is unavailable
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }
  async verify() {
    try {
      await this.transport.verify();
    } catch (e) {
      throw new ProviderError(`SMTP connection failed: ${(e as Error).message}`, undefined, undefined, true);
    }
  }
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transport.sendMail({
        from: { name: this.cfg.fromName, address: this.cfg.fromEmail },
        replyTo: this.cfg.replyTo || undefined,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })),
      });
      const rejected = (info.rejected ?? []).length > 0 && (info.accepted ?? []).length === 0;
      return { status: rejected ? 'rejected' : 'accepted', messageId: info.messageId, response: info.response, simulated: false };
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode;
      // 5xx SMTP replies are permanent (bad recipient, auth failure); 4xx and network errors are temporary.
      throw new ProviderError(`SMTP send failed: ${(e as Error).message}`, code, undefined, !(code && code >= 500));
    }
  }
}

/** Development/test-only transport (nodemailer JSON transport). Never used in production. */
export class MockEmailProvider implements EmailProvider {
  name = 'mock';
  static sent: EmailMessage[] = [];
  private transport = nodemailer.createTransport({ jsonTransport: true });
  async verify() {}
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transport.sendMail({ from: 'mock@chilipos.local', ...msg, attachments: undefined });
    MockEmailProvider.sent.push(msg);
    return { status: 'accepted', messageId: info.messageId, response: 'simulated', simulated: true };
  }
}
