import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose, { Types } from 'mongoose';
import { env, isProd } from '../config/env';
import { Business, LiveLink, LiveMirror } from '../models';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { AppError, badRequest } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Live link: the restaurant's own server (the "local" server the tills use, which keeps working without internet)
 * sends a copy of all its data to a live server on the internet, so the owner can follow sales from anywhere.
 *
 * - Changes go one way, local -> live. The live server is a read-only copy (see liveCopyGuard) — the local server is the
 *   single source of truth, so there are never two versions of an order to reconcile.
 * - Every collection is sent in (updatedAt, _id) order from a per-collection cursor; documents are replaced whole on
 *   the live server, so repeating a send is harmless. When the internet is down nothing is lost: the cursors simply
 *   don't move, and everything waiting is sent once the connection is back.
 * - An hourly comparison of ids and timestamps catches anything the cursors cannot see (deleted documents, a change
 *   committed late by a long transaction) and repairs it.
 */

/** Never copied: sessions and device tokens, local job queues (the live server must not send SMS or print again),
 *  number counters, and integration credentials (encrypted with this server's key). */
const EXCLUDED = new Set([
  'RefreshToken', 'Terminal', 'Counter', 'Job', 'NotificationJob', 'PrintJob', 'BridgeCommand', 'BridgeAgent',
  'IntegrationConfiguration', 'IntegrationLog', 'LiveLink', 'LiveMirror',
]);
/** Write-once collections: never deleted locally, so the comparison never removes them on the live server either. */
const APPEND_ONLY = new Set(['auditlogs', 'stockledgers', 'recipeversions']);

export interface SyncSpec { model: string; collection: string; ts: 'updatedAt' | 'createdAt'; appendOnly: boolean }

export function syncSpecs(): SyncSpec[] {
  return Object.values(mongoose.models)
    .filter((m) => !EXCLUDED.has(m.modelName) && (m.modelName === 'Tenant' || m.schema.path('tenantId')))
    .map((m) => ({ model: m.modelName, collection: m.collection.collectionName, ts: m.schema.path('updatedAt') ? 'updatedAt' as const : 'createdAt' as const, appendOnly: APPEND_ONLY.has(m.collection.collectionName) }))
    .sort((a, b) => (a.model === 'Tenant' ? -1 : b.model === 'Tenant' ? 1 : a.collection.localeCompare(b.collection)));
}
export const specFor = (collection: string) => syncSpecs().find((s) => s.collection === collection);
/** The documents of the business in a collection (the business document itself for `tenants`). */
export const scopeOf = (collection: string, businessId: Types.ObjectId) => (collection === 'tenants' ? { _id: businessId } : { tenantId: businessId });
const coll = (name: string) => mongoose.connection.db!.collection(name);
const EJSON = mongoose.mongo.BSON.EJSON;
export const EJSON_TYPE = 'application/ejson';

type Doc = Record<string, unknown> & { _id: Types.ObjectId };

/** Prepare a document for sending: drop one-time reset tokens; send an MFA secret in clear (over HTTPS) so the live
 *  server can store it under its own encryption key. */
function outgoing(collection: string, d: Doc): Doc {
  if (collection !== 'users') return d;
  const { passwordResetTokenHash: _h, passwordResetExpires: _e, ...rest } = d;
  const mfa = rest.mfa as { secretEnc?: string } | undefined;
  if (mfa?.secretEnc) {
    const { secretEnc, ...m } = mfa;
    try {
      rest.mfa = { ...m, secretPlain: decryptSecret(secretEnc) };
    } catch {
      rest.mfa = m;
    }
  }
  return rest as Doc;
}

/** Live server side: store a received document, re-encrypting an MFA secret under this server's key. */
export function incoming(collection: string, d: Doc): Doc {
  if (collection !== 'users') return d;
  const mfa = d.mfa as { secretPlain?: string } | undefined;
  if (mfa?.secretPlain) {
    const { secretPlain, ...m } = mfa;
    d.mfa = { ...m, secretEnc: encryptSecret(secretPlain) };
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------------
// Local server: talking to the live server
// ---------------------------------------------------------------------------------------------------------------------

export function normaliseLiveUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw badRequest('Enter the live server address, e.g. https://pos.myrestaurant.co.ke');
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  // Staff password hashes and sales travel over this link: plain http only for a server on this machine (testing).
  if (u.protocol !== 'https:' && !(local || !isProd)) throw badRequest('The live server address must start with https://');
  return `${u.protocol}//${u.host}`;
}

async function call(url: string, pathname: string, opts: { key?: string; json?: unknown; ejson?: unknown; body?: Buffer; method?: string; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = { 'X-Requested-With': 'chili-pos' };
  let body: string | Uint8Array | undefined;
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.ejson !== undefined) { headers['Content-Type'] = EJSON_TYPE; body = EJSON.stringify(opts.ejson, { relaxed: false }); }
  if (opts.body) { headers['Content-Type'] = 'application/octet-stream'; body = new Uint8Array(opts.body); }
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1${pathname}`, { method: opts.method ?? 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    const why = err.name === 'TimeoutError' ? 'it did not answer in time' : err.cause?.code === 'ENOTFOUND' ? 'the address was not found' : 'no connection';
    throw new AppError(502, 'LIVE_UNREACHABLE', `Could not reach the live server (${why})`);
  }
  const text = await res.text();
  let parsed: { data?: unknown; error?: { code?: string; message?: string; details?: unknown } } = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* not JSON: an HTML error page from a proxy, for example */ }
  if (!res.ok) {
    if (!parsed.error && res.status === 404) throw new AppError(502, 'LIVE_NOT_CHILI', 'That address does not look like a Chili POS server (or it runs an older version — update it first)');
    throw new AppError(res.status >= 500 ? 502 : res.status, parsed.error?.code ?? 'LIVE_ERROR', parsed.error?.message ?? `The live server answered ${res.status}`, parsed.error?.details);
  }
  return parsed.data as Record<string, unknown>;
}

/** Link this (local) server to a live server, using the live server's setup token once. */
export async function linkLive(tenantId: Types.ObjectId, input: { url: string; setupToken: string; replaceEmpty?: boolean; by?: string }) {
  const url = normaliseLiveUrl(input.url);
  const biz = await Business.findById(tenantId).lean();
  if (!biz) throw badRequest('Finish setting up this server first');
  if (await LiveMirror.exists({})) throw new AppError(409, 'IS_LIVE_COPY', 'This server is itself a live copy; link from the restaurant server instead');
  const r = await call(url, '/live/link', { json: { setupToken: input.setupToken, businessId: String(tenantId), businessName: biz.name, sourceName: os.hostname(), replaceEmpty: !!input.replaceEmpty } });
  const key = String(r.key ?? '');
  if (!key) throw new AppError(502, 'LIVE_ERROR', 'The live server did not return a link key');
  await LiveLink.updateOne(
    { tenantId },
    { $set: { url, keyEnc: encryptSecret(key), liveName: String(r.name ?? url), linkedAt: new Date(), linkedBy: input.by, enabled: true, cursors: {}, uploads: [], docsSent: 0, lastError: null, lastSuccessAt: null, lastCompareAt: null } },
    { upsert: true },
  );
  return { url, name: r.name };
}

export async function unlinkLive(tenantId: Types.ObjectId) {
  await LiveLink.deleteOne({ tenantId });
}

// ---------------------------------------------------------------------------------------------------------------------
// Local server: sending changes
// ---------------------------------------------------------------------------------------------------------------------

const BATCH = 200;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** Changes younger than this wait for the next round, so a transaction still committing isn't skipped over. */
const SETTLE_MS = 3_000;
const COMPARE_EVERY_MS = 60 * 60_000;
const COMPARE_CHUNK = 5_000;

let running: Promise<SyncResult | null> | null = null;
export interface SyncResult { sent: number; repaired: number; removed: number; files: number }

/** One sync round (no-op when not linked). Concurrent calls share the round that is already running. */
export function runLiveSync(opts: { compare?: boolean } = {}) {
  running ??= (async () => {
    try {
      return await syncOnce(opts);
    } finally {
      running = null;
    }
  })();
  return running;
}
export const liveSyncRunning = () => running !== null;

async function syncOnce(opts: { compare?: boolean }): Promise<SyncResult | null> {
  const biz = await Business.findOne({ singleton: 'business' }).select('_id').lean();
  if (!biz) return null;
  const tenantId = biz._id as Types.ObjectId;
  const link = await LiveLink.findOne({ tenantId, enabled: true }).select('+keyEnc').lean();
  if (!link) return null;
  const key = decryptSecret(link.keyEnc);
  const result: SyncResult = { sent: 0, repaired: 0, removed: 0, files: 0 };
  await LiveLink.updateOne({ tenantId }, { $set: { lastAttemptAt: new Date() } });
  try {
    const push = (batches: Array<{ c: string; docs: Doc[] }>) => call(link.url, '/live/push', { key, ejson: { batches } }) as Promise<{ refetch?: Array<{ c: string; id: string }> }>;
    const pushIds = async (c: string, ids: Types.ObjectId[]) => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const docs = (await coll(c).find({ ...scopeOf(c, tenantId), _id: { $in: ids.slice(i, i + BATCH) } }).toArray()) as Doc[];
        if (docs.length) await push([{ c, docs: docs.map((d) => outgoing(c, d)) }]);
        result.repaired += docs.length;
      }
    };
    const cursors = (link.cursors ?? {}) as Record<string, { t: number; id: string | null }>;
    const settled = new Date(Date.now() - SETTLE_MS);

    for (const s of syncSpecs()) {
      for (;;) {
        const cur = cursors[s.collection] ?? { t: 0, id: null };
        const after = cur.id
          ? { $or: [{ [s.ts]: { $gt: new Date(cur.t) } }, { [s.ts]: new Date(cur.t), _id: { $gt: new Types.ObjectId(cur.id) } }] }
          : { [s.ts]: { $gte: new Date(cur.t) } };
        const docs = (await coll(s.collection).find({ ...scopeOf(s.collection, tenantId), $and: [after, { [s.ts]: { $lte: settled } }] }).sort({ [s.ts]: 1, _id: 1 }).limit(BATCH).toArray()) as Doc[];
        if (!docs.length) break;
        // Keep requests a sensible size (orders with many lines, or large documents).
        let size = 0;
        let n = 0;
        for (const d of docs) {
          size += Buffer.byteLength(EJSON.stringify(d));
          n++;
          if (size > MAX_BATCH_BYTES) break;
        }
        const part = docs.slice(0, Math.max(1, n));
        const r = await push([{ c: s.collection, docs: part.map((d) => outgoing(s.collection, d)) }]);
        const last = part[part.length - 1];
        cursors[s.collection] = { t: (last[s.ts] as Date).getTime(), id: String(last._id) };
        result.sent += part.length;
        await LiveLink.updateOne({ tenantId }, { $set: { [`cursors.${s.collection}`]: cursors[s.collection] }, $inc: { docsSent: part.length } });
        // A document the live server had to drop to make room (a unique value moved between documents) is resent.
        for (const [c, ids] of groupIds(r.refetch)) await pushIds(c, ids);
      }
    }

    // Also check everything right after an outage (lastError), not only once an hour.
    if (opts.compare || link.lastError || !link.lastCompareAt || Date.now() - new Date(link.lastCompareAt).getTime() > COMPARE_EVERY_MS) {
      for (const s of syncSpecs()) {
        let afterId: Types.ObjectId | null = null;
        for (;;) {
          const items = (await coll(s.collection).find({ ...scopeOf(s.collection, tenantId), ...(afterId ? { _id: { $gt: afterId } } : {}) }, { projection: { _id: 1, [s.ts]: 1 } }).sort({ _id: 1 }).limit(COMPARE_CHUNK).toArray()) as Doc[];
          const full = items.length === COMPARE_CHUNK;
          const upTo = full ? items[items.length - 1]._id : null;
          const r = (await call(link.url, '/live/compare', { key, ejson: { c: s.collection, after: afterId, upTo, items: items.map((d) => [d._id, (d[s.ts] as Date | undefined)?.getTime() ?? null]) } })) as { need?: string[]; removed?: number };
          result.removed += r.removed ?? 0;
          if (r.need?.length) await pushIds(s.collection, r.need.map((id) => new Types.ObjectId(id)));
          if (!full) break;
          afterId = upTo;
        }
      }
      await LiveLink.updateOne({ tenantId }, { $set: { lastCompareAt: new Date() } });
    }

    result.files = await pushUploads(link.url, key, tenantId, new Set(link.uploads ?? []));
    await LiveLink.updateOne({ tenantId }, { $set: { lastSuccessAt: new Date(), lastError: null } });
    if (result.sent || result.repaired || result.removed || result.files) logger.info({ ...result }, 'Live sync: changes sent');
    return result;
  } catch (e) {
    const message = e instanceof AppError ? e.message : 'Sync failed — see the server log';
    if (!(e instanceof AppError)) logger.error({ err: e }, 'Live sync failed');
    await LiveLink.updateOne({ tenantId }, { $set: { lastError: message } });
    throw e;
  }
}

function groupIds(list?: Array<{ c: string; id: string }>) {
  const m = new Map<string, Types.ObjectId[]>();
  for (const r of list ?? []) if (specFor(r.c) && Types.ObjectId.isValid(r.id)) m.set(r.c, [...(m.get(r.c) ?? []), new Types.ObjectId(r.id)]);
  return m;
}

/** Copy product images and the logo (UPLOAD_DIR/<business id>/…) that the live server doesn't have yet. */
async function pushUploads(url: string, key: string, tenantId: Types.ObjectId, done: Set<string>) {
  const dir = path.resolve(env.UPLOAD_DIR, String(tenantId));
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile() && UPLOAD_NAME.test(f.name)).map((f) => f.name);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names.filter((x) => !done.has(x))) {
    const body = await fs.readFile(path.join(dir, name));
    if (body.length > env.MAX_UPLOAD_MB * 1024 * 1024) continue;
    await call(url, `/live/uploads/${encodeURIComponent(name)}`, { key, body, method: 'PUT' });
    await LiveLink.updateOne({ tenantId }, { $addToSet: { uploads: name } });
    n++;
  }
  return n;
}
export const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** Rough count of changes not yet sent (for the settings screen). The last 30 seconds are left out: they go with the
 *  next round anyway, so a count above zero means a real backlog (no internet, or a large first copy). */
export async function pendingChanges(tenantId: Types.ObjectId, cursors: Record<string, { t: number; id: string | null }>) {
  let n = 0;
  const recent = new Date(Date.now() - 30_000);
  for (const s of syncSpecs()) {
    const cur = cursors[s.collection];
    n += await coll(s.collection).countDocuments({ ...scopeOf(s.collection, tenantId), [s.ts]: { ...(cur ? { $gt: new Date(cur.t) } : {}), $lte: recent } });
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Live server: is this a read-only copy?
// ---------------------------------------------------------------------------------------------------------------------

let mirrorCache: { at: number; value: boolean } | null = null;
export async function isLiveCopy() {
  if (mirrorCache && Date.now() - mirrorCache.at < 5_000) return mirrorCache.value;
  const value = !!(await LiveMirror.exists({}));
  mirrorCache = { at: Date.now(), value };
  return value;
}
export const forgetLiveCopyCache = () => {
  mirrorCache = null;
};
