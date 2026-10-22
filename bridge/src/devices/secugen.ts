import https from 'node:https';
import { config } from '../config';
import type { DeviceAdapter, DeviceInfo, Punch } from './types';
import * as store from './templateStore';

/**
 * SecuGen USB readers through the SecuGen WebAPI service (SGIBioSrv) installed on this PC.
 * Endpoints: POST /SGIFPCapture (capture template), POST /SGIMatchScore (compare two templates).
 * Status: UNVERIFIED — requires the SecuGen WebAPI installer and a licence string for production use.
 */
const agent = new https.Agent({ rejectUnauthorized: false }); // SGIBioSrv uses a self-signed certificate on localhost only

async function call(endpoint: string, params: Record<string, string | number>): Promise<any> {
  const body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = new URL(`${config.secugenUrl}/${endpoint}`);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('SECUGEN_WEBAPI_URL must point to this PC');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.ErrorCode && j.ErrorCode !== 0) reject(new Error(`SecuGen error ${j.ErrorCode}${j.ErrorCode === 54 ? ' (timeout — no finger detected)' : ''}`));
          else resolve(j);
        } catch {
          reject(new Error('Unexpected response from SecuGen WebAPI'));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`SecuGen WebAPI not reachable at ${config.secugenUrl}: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('SecuGen WebAPI timed out')));
    req.end(body);
  });
}

export async function capture(): Promise<{ template: string; quality: number }> {
  const r = await call('SGIFPCapture', { Timeout: 10000, Quality: 50, licstr: config.secugenLicense, templateFormat: 'ISO' });
  return { template: r.TemplateBase64, quality: Number(r.ImageQuality ?? 0) };
}

export async function matchScore(a: string, b: string): Promise<number> {
  const r = await call('SGIMatchScore', { Template1: a, Template2: b, licstr: config.secugenLicense, templateFormat: 'ISO' });
  return Number(r.MatchingScore ?? 0);
}

/** Identify a captured finger against locally stored templates. Returns the employee's device user code. */
export async function identify(template: string, threshold = 100): Promise<string | null> {
  let best: { code: string; score: number } | null = null;
  for (const [code, rec] of Object.entries(store.load())) {
    for (const t of rec.templates) {
      const score = await matchScore(template, t);
      if (score >= threshold && (!best || score > best.score)) best = { code, score };
    }
  }
  return best?.code ?? null;
}

export class SecugenAdapter implements DeviceAdapter {
  constructor(private d: DeviceInfo) {}
  async test() {
    // A capture attempt with a short timeout proves the service and reader respond.
    try {
      await call('SGIFPCapture', { Timeout: 1500, Quality: 50, licstr: config.secugenLicense, templateFormat: 'ISO' });
    } catch (e) {
      if (!/timeout/i.test((e as Error).message)) throw e;
    }
    return { ok: true as const, details: { service: config.secugenUrl, enrolled: Object.keys(store.load()).length } };
  }
  async syncTime() {
    // USB readers have no clock; events are timestamped by this PC.
  }
  async pullAttendance(): Promise<Punch[]> {
    return []; // events are pushed in real time from the kiosk page
  }
  async listUsers() {
    return Object.entries(store.load()).map(([userCode, r]) => ({ userCode, name: r.name }));
  }
  /** Capture the same finger twice; both must match each other before the template is stored. */
  async enrollUser(input: { deviceUserCode: string; name: string; fingerIndex: number }) {
    const a = await capture();
    const b = await capture();
    if ((await matchScore(a.template, b.template)) < 100) throw new Error('The two scans did not match — try again');
    const s = store.load();
    s[input.deviceUserCode] = { name: input.name, templates: [a.template, b.template], enrolledAt: new Date().toISOString() };
    store.save(s);
    return { message: `Fingerprint enrolled for ${input.name} on this PC (stored encrypted locally).` };
  }
  async deleteUser(deviceUserCode: string) {
    store.remove(deviceUserCode);
  }
}
