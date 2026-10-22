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
    // While the customer has not responded Daraja returns HTTP 500 with errorCode 500.001.1001 ("The transaction is being processed").
    if (body?.errorCode === '500.001.1001') return { pending: true, raw: body };
    if (status !== 200) throw new ProviderError(`STK query failed: ${body?.errorMessage ?? `HTTP ${status}`}`, status, body, isRetryableStatus(status));
    return { pending: false, resultCode: Number(body.ResultCode), resultDesc: body.ResultDesc, raw: body };
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
