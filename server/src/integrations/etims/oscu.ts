import crypto from 'node:crypto';
import { httpJson } from '../http';

/**
 * KRA eTIMS OSCU (Online Sales Control Unit) API, per KRA's "OSCU Specification Document v2.0".
 * JSON over HTTPS POST; every answer carries `resultCd` ("000" = success, "001" = no results).
 * Not yet verified against a live KRA account — use the sandbox until KRA certifies the integration.
 */
export const OSCU_URLS = {
  sandbox: 'https://etims-api-sbx.kra.go.ke/etims-api',
  production: 'https://etims-api.kra.go.ke/etims-api',
} as const;
/** Public page that the receipt QR code links to (KRA's receipt lookup). */
export const RECEIPT_URLS = {
  sandbox: 'https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData',
  production: 'https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData',
} as const;

/** Why a call failed: `transport` may be retried with the same data; `rejected` needs a fix first. */
export class EtimsError extends Error {
  constructor(message: string, public type: 'transport' | 'rejected' | 'duplicate' | 'config', public resultCd?: string) {
    super(message);
  }
}

export interface SaleSignature { sdcId?: string; curRcptNo?: number; totRcptNo?: number; intrlData?: string; rcptSign?: string; sdcDateTime?: string; mrcNo?: string }
export interface EtimsClient {
  simulated: boolean;
  /** A read-only call that proves the PIN, branch and communication key work. */
  ping(): Promise<void>;
  initialize(deviceSerial: string): Promise<{ cmcKey: string; sdcId?: string; mrcNo?: string; taxpayerName?: string; branchName?: string }>;
  saveItem(body: Record<string, unknown>): Promise<void>;
  saveSale(body: Record<string, unknown>): Promise<SaleSignature>;
}

/** KRA result codes that mean "already recorded" (the earlier send got through). */
const DUPLICATE = new Set(['921', '994']);
/** Answers where nothing was saved and trying again later can work (server busy / unknown error on KRA's side). */
const RETRY = new Set(['896', '899', '999']);

export class OscuClient implements EtimsClient {
  simulated = false;
  constructor(private cfg: { baseUrl: string; tin: string; bhfId: string; cmcKey?: string; timeoutMs?: number }) {}

  private async post(path: string, body: Record<string, unknown>, auth = true) {
    // The specification lists tin/bhfId/cmcKey as request fields; KRA's servers read them from headers. Send both.
    const id = { tin: this.cfg.tin, bhfId: this.cfg.bhfId, ...(auth ? { cmcKey: this.cfg.cmcKey ?? '' } : {}) };
    let res;
    try {
      res = await httpJson(this.cfg.baseUrl.replace(/\/+$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(auth ? id : {}) },
        body: JSON.stringify({ ...id, ...body }),
        timeoutMs: this.cfg.timeoutMs ?? 30_000,
      });
    } catch (e) {
      throw new EtimsError(`Could not reach KRA: ${(e as Error).message}`, 'transport');
    }
    if (res.status !== 200) throw new EtimsError(`KRA answered HTTP ${res.status}`, res.status >= 500 || res.status === 429 ? 'transport' : 'rejected');
    const env = res.body as { resultCd?: string; resultMsg?: string; data?: Record<string, any> } | null;
    if (!env || typeof env !== 'object' || env.resultCd === undefined) throw new EtimsError('KRA sent an answer without a result code', 'transport');
    const code = String(env.resultCd).trim();
    if (code === '000' || code === '001') return env.data ?? {};
    const msg = `KRA ${code}: ${String(env.resultMsg ?? 'refused').trim()}`;
    if (DUPLICATE.has(code)) throw new EtimsError(msg, 'duplicate', code);
    throw new EtimsError(msg, RETRY.has(code) ? 'transport' : 'rejected', code);
  }

  async initialize(deviceSerial: string) {
    const data = await this.post('/selectInitOsdcInfo', { dvcSrlNo: deviceSerial }, false);
    const info = (data.info ?? {}) as Record<string, any>;
    if (!info.cmcKey) throw new EtimsError('KRA did not return a communication key (cmcKey)', 'rejected');
    return { cmcKey: String(info.cmcKey), sdcId: info.sdcId, mrcNo: info.mrcNo, taxpayerName: info.taxprNm, branchName: info.bhfNm };
  }

  async ping() {
    await this.post('/selectCodeList', { lastReqDt: '20200101000000' });
  }

  async saveItem(body: Record<string, unknown>) {
    await this.post('/saveItem', body);
  }

  async saveSale(body: Record<string, unknown>) {
    const d = (await this.post('/saveTrnsSalesOsdc', body)) as Record<string, any>;
    // KRA's sample answers contain keys with trailing spaces ("curRcptNo ").
    const r = Object.fromEntries(Object.entries(d).map(([k, v]) => [k.trim(), v]));
    if (!r.rcptSign) throw new EtimsError('KRA accepted the sale but sent no receipt signature', 'transport');
    return { sdcId: r.sdcId, curRcptNo: Number(r.curRcptNo ?? r.rcptNo) || undefined, totRcptNo: Number(r.totRcptNo) || undefined, intrlData: r.intrlData, rcptSign: r.rcptSign, sdcDateTime: r.sdcDateTime, mrcNo: r.mrcNo };
  }
}

/** Development stand-in: signs locally, sends nothing to KRA. `failNext` simulates KRA being unreachable. */
export class MockEtimsClient implements EtimsClient {
  simulated = true;
  static failNext = 0;
  static received: Array<{ path: string; body: Record<string, unknown> }> = [];
  private static rcpt = 0;
  async ping() {}
  async initialize() {
    return { cmcKey: crypto.randomBytes(16).toString('hex'), sdcId: 'KRACU0100000001', mrcNo: 'WIS00000001', taxpayerName: 'Simulated taxpayer', branchName: 'Headquarter' };
  }
  async saveItem(body: Record<string, unknown>) {
    MockEtimsClient.received.push({ path: '/saveItem', body });
  }
  async saveSale(body: Record<string, unknown>) {
    if (MockEtimsClient.failNext > 0) {
      MockEtimsClient.failNext -= 1;
      throw new EtimsError('Could not reach KRA: simulated outage', 'transport');
    }
    MockEtimsClient.received.push({ path: '/saveTrnsSalesOsdc', body });
    const n = ++MockEtimsClient.rcpt;
    const sign = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16).toUpperCase();
    const eat = new Date(Date.now() + 3 * 3600_000).toISOString(); // KRA's control unit answers in Kenyan time
    return { sdcId: 'KRACU0100000001', curRcptNo: n, totRcptNo: n, intrlData: sign.slice(0, 26).padEnd(26, 'X'), rcptSign: sign, sdcDateTime: eat.slice(0, 19).replace(/\D/g, ''), mrcNo: 'WIS00000001' };
  }
}
