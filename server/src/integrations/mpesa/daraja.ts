import crypto from 'node:crypto';
import { httpJson, ProviderError, isRetryableStatus } from '../http';

/**
 * Safaricom Daraja (M-Pesa) client — Lipa Na M-Pesa Online (STK Push), STK status query and C2B URL registration.
 * Contract per https://developer.safaricom.co.ke (Authorization, M-Pesa Express, C2B APIs).
 */
export interface DarajaConfig {
  environment: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  shortCode: string; // BusinessShortCode (Paybill, or Head Office/store number for Buy Goods)
  passkey: string;
  transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  /** PartyB: Paybill number, or Till number for Buy Goods. Defaults to shortCode. */
  partyB?: string;
  /** Org-portal API user with the "Transaction Status Query" role, and its encrypted password (security credential). */
  initiatorName?: string;
  securityCredential?: string;
}

/**
 * Daraja's SecurityCredential: the initiator password encrypted with Safaricom's public certificate (RSA, PKCS#1 v1.5),
 * base64. The certificate (sandbox or production) is downloaded from the Daraja portal; a PEM pasted into a one-line
 * field loses its line breaks, so it is rebuilt here.
 */
export function securityCredential(initiatorPassword: string, certificate: string) {
  const body = certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return crypto.publicEncrypt({ key: new crypto.X509Certificate(pem).publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(initiatorPassword)).toString('base64');
}

/** The interesting parts of a Transaction Status result (sent asynchronously to the ResultURL). */
export interface StatusResult { resultCode: number; resultDesc: string; payerName?: string; payerPhone?: string; receipt?: string; amount?: number; transactionStatus?: string }
export function parseStatusResult(body: any): StatusResult | null {
  const r = body?.Result;
  if (!r || r.ResultCode === undefined) return null;
  const params = new Map<string, unknown>(((r.ResultParameters?.ResultParameter ?? []) as Array<{ Key: string; Value: unknown }>).map((p) => [p.Key, p.Value]));
  // DebitPartyName looks like "254712345678 - JANE WANJIKU DOE" (phone or short code, then the registered name).
  const debit = String(params.get('DebitPartyName') ?? '').trim();
  const dash = debit.indexOf(' - ');
  const payerName = (dash >= 0 ? debit.slice(dash + 3) : /\d{6,}/.test(debit) ? '' : debit).trim() || undefined;
  const payerPhone = dash >= 0 ? debit.slice(0, dash).trim() : undefined;
  const amount = params.has('Amount') ? Number(params.get('Amount')) : undefined;
  return { resultCode: Number(r.ResultCode), resultDesc: String(r.ResultDesc ?? ''), payerName, payerPhone, receipt: params.get('ReceiptNo') ? String(params.get('ReceiptNo')) : undefined, amount, transactionStatus: params.get('TransactionStatus') ? String(params.get('TransactionStatus')) : undefined };
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
}

export interface StkCallbackParsed {
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  amount?: number;
  mpesaReceipt?: string;
  transactionDate?: string;
  phone?: string;
}

const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' } as const;
const tokenCache = new Map<string, { token: string; exp: number }>();

/** Daraja timestamps are YYYYMMDDHHmmss in East Africa Time. */
export function darajaTimestamp(d = new Date()) {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export function stkPassword(shortCode: string, passkey: string, timestamp: string) {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

export class DarajaClient {
  constructor(private cfg: DarajaConfig) {}
  private get base() {
    return BASE[this.cfg.environment];
  }

  async accessToken(): Promise<string> {
    const key = `${this.cfg.environment}:${this.cfg.consumerKey}`;
    const hit = tokenCache.get(key);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const auth = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const { status, body } = await httpJson(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    if (status !== 200 || !body?.access_token) {
      throw new ProviderError(`Daraja authentication failed (HTTP ${status})${body?.errorMessage ? `: ${body.errorMessage}` : ''}`, status, body, isRetryableStatus(status));
    }
    tokenCache.set(key, { token: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3599) * 1000 });
    return body.access_token;
  }

  async stkPush(input: { phone: string; amountKes: number; callbackUrl: string; accountReference: string; description: string }): Promise<StkPushResult> {
    if (!Number.isInteger(input.amountKes) || input.amountKes < 1) throw new ProviderError('M-Pesa amount must be a whole number of shillings ≥ 1', 400, undefined, false);
    const ts = darajaTimestamp();
    const token = await this.accessToken();
    const payload = {
      BusinessShortCode: this.cfg.shortCode,
      Password: stkPassword(this.cfg.shortCode, this.cfg.passkey, ts),
      Timestamp: ts,
      TransactionType: this.cfg.transactionType,
      Amount: input.amountKes,
      PartyA: input.phone,
      PartyB: this.cfg.partyB || this.cfg.shortCode,
      PhoneNumber: input.phone,
      CallBackURL: input.callbackUrl,
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    };
    const { status, body } = await httpJson(`${this.base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (status !== 200 || body?.ResponseCode !== '0') {
      throw new ProviderError(`STK Push rejected: ${body?.errorMessage ?? body?.ResponseDescription ?? `HTTP ${status}`}`, status, body, isRetryableStatus(status));
    }
    return {
      merchantRequestId: body.MerchantRequestID,
      checkoutRequestId: body.CheckoutRequestID,
      responseCode: body.ResponseCode,
      responseDescription: body.ResponseDescription,
      customerMessage: body.CustomerMessage,
    };
  }

  /** Query the final status of an STK Push. ResultCode 0 = paid; 1032 = cancelled by user; 1037 = timeout; etc. */
  async stkQuery(checkoutRequestId: string): Promise<{ pending: boolean; resultCode?: number; resultDesc?: string; raw: unknown }> {
    const ts = darajaTimestamp();
    const token = await this.accessToken();
    const { status, body } = await httpJson(`${this.base}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: this.cfg.shortCode, Password: stkPassword(this.cfg.shortCode, this.cfg.passkey, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }),
    });
    // Still waiting for the customer (PIN not entered yet). Daraja says so in several ways: HTTP 500 with errorCode
    // 500.001.1001, or HTTP 200 with ResultCode 4999 — both "The transaction is (still) under/being processed".
    // Asking too often gets a spike-arrest/throttling error: that is not an answer either, so keep waiting.
    const text = `${body?.errorMessage ?? ''} ${body?.ResultDesc ?? ''}`;
    if (body?.errorCode === '500.001.1001' || String(body?.ResultCode) === '4999' || /under processing|being processed|in progress/i.test(text)) return { pending: true, raw: body };
    if (status === 429 || /spike arrest|throttl|rate limit/i.test(text)) return { pending: true, raw: body };
    if (status !== 200) throw new ProviderError(`STK query failed: ${body?.errorMessage ?? `HTTP ${status}`}`, status, body, isRetryableStatus(status));
    return { pending: false, resultCode: Number(body.ResultCode), resultDesc: body.ResultDesc, raw: body };
  }

  /**
   * Transaction Status query (CommandID TransactionStatusQuery). Only an acknowledgement comes back here; the details —
   * including the payer's registered name — are POSTed later to resultUrl.
   */
  async transactionStatus(input: { receipt?: string; originalConversationId?: string; resultUrl: string; timeoutUrl: string }) {
    if (!this.cfg.initiatorName || !this.cfg.securityCredential) throw new ProviderError('Transaction status needs an initiator name and security credential', 400, null, false);
    const token = await this.accessToken();
    const { status, body } = await httpJson(`${this.base}/mpesa/transactionstatus/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Initiator: this.cfg.initiatorName, SecurityCredential: this.cfg.securityCredential, CommandID: 'TransactionStatusQuery',
        ...(input.receipt ? { TransactionID: input.receipt } : { OriginalConversationID: input.originalConversationId }),
        PartyA: this.cfg.shortCode, IdentifierType: '4', ResultURL: input.resultUrl, QueueTimeOutURL: input.timeoutUrl, Remarks: 'Payer name', Occasion: 'POS',
      }),
    });
    if (status !== 200 || (body?.ResponseCode !== undefined && String(body.ResponseCode) !== '0')) throw new ProviderError(`Transaction status failed: ${body?.errorMessage ?? body?.ResponseDescription ?? `HTTP ${status}`}`, status, body, isRetryableStatus(status));
    return { conversationId: body?.ConversationID as string | undefined, originatorConversationId: body?.OriginatorConversationID as string | undefined };
  }

  async registerC2BUrls(input: { confirmationUrl: string; validationUrl: string; responseType: 'Completed' | 'Cancelled' }) {
    const token = await this.accessToken();
    const { status, body } = await httpJson(`${this.base}/mpesa/c2b/v1/registerurl`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ShortCode: this.cfg.partyB || this.cfg.shortCode, ResponseType: input.responseType, ConfirmationURL: input.confirmationUrl, ValidationURL: input.validationUrl }),
    });
    if (status !== 200) throw new ProviderError(`C2B URL registration failed: ${body?.errorMessage ?? `HTTP ${status}`}`, status, body, isRetryableStatus(status));
    return body;
  }
}

/** Parse and structurally validate a Daraja STK callback body. Returns null if the shape is wrong. */
export function parseStkCallback(body: any): StkCallbackParsed | null {
  const cb = body?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== 'string' || typeof cb.MerchantRequestID !== 'string' || cb.ResultCode === undefined) return null;
  const out: StkCallbackParsed = {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc ?? ''),
  };
  const items: Array<{ Name: string; Value?: unknown }> = Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [];
  for (const it of items) {
    if (it.Name === 'Amount') out.amount = Number(it.Value);
    if (it.Name === 'MpesaReceiptNumber') out.mpesaReceipt = String(it.Value);
    if (it.Name === 'TransactionDate') out.transactionDate = String(it.Value);
    if (it.Name === 'PhoneNumber') out.phone = String(it.Value);
  }
  return out;
}

/** Human readable descriptions of common STK result codes. */
export const STK_RESULT_CODES: Record<number, string> = {
  0: 'Payment received',
  1: 'Insufficient M-Pesa balance',
  1001: 'Customer has another transaction in progress',
  1019: 'Transaction expired',
  1025: 'Unable to send prompt — try again',
  1032: 'Customer cancelled the prompt',
  1037: 'Customer phone unreachable / prompt timed out',
  2001: 'Wrong M-Pesa PIN entered',
};
