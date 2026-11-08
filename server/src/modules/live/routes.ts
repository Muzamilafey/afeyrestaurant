import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { createModule } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import { env } from '../../config/env';
import { Business, LiveLink, LiveMirror, Order, Payment, RefreshToken } from '../../models';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto';
import { AppError, badRequest } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { withTransaction } from '../../db/connect';
import { audit } from '../../services/audit';
import {
  EJSON_TYPE, UPLOAD_NAME, forgetLiveCopyCache, incoming, isLiveCopy, linkLive, liveSyncRunning, pendingChanges, runLiveSync, scopeOf, specFor, unlinkLive,
} from '../../services/liveSync';

const m = createModule('/live', 'Live server');
const EJSON = mongoose.mongo.BSON.EJSON;
const ejsonBody = express.text({ type: EJSON_TYPE, limit: '25mb' });
const coll = (name: string) => mongoose.connection.db!.collection(name);

// ---------------------------------------------------------------------------------------------------------------------
// On the restaurant's (local) server: Settings → Live server
// ---------------------------------------------------------------------------------------------------------------------

m.route({ method: 'get', path: '/status', summary: 'Live server link status', auth: 'tenant', permission: P.SETTINGS_MANAGE }, async ({ ctx }) => {
  const mirror = await LiveMirror.findOne({}).lean();
  if (mirror) return { role: 'live', sourceName: mirror.sourceName, linkedAt: mirror.linkedAt, lastPushAt: mirror.lastPushAt, docsReceived: mirror.docsReceived };
  const link = await LiveLink.findOne({ tenantId: ctx.tenantId }).lean();
  if (!link) return { role: 'local', linked: false };
  return {
    role: 'local', linked: true, url: link.url, liveName: link.liveName, linkedAt: link.linkedAt, linkedBy: link.linkedBy, lastAttemptAt: link.lastAttemptAt,
    lastSuccessAt: link.lastSuccessAt, lastCompareAt: link.lastCompareAt, lastError: link.lastError, docsSent: link.docsSent,
    pending: await pendingChanges(ctx.tenantId as Types.ObjectId, (link.cursors ?? {}) as Record<string, { t: number; id: string | null }>), syncing: liveSyncRunning(),
  };
});

m.route(
  {
    method: 'post', path: '/connect', summary: 'Link this server to a live server and start sending data', auth: 'tenant', permission: P.SETTINGS_MANAGE,
    body: z.object({ url: z.string().min(3).max(300), setupToken: z.string().min(1).max(300), replaceEmpty: z.boolean().optional() }),
  },
  async ({ ctx, body, req }) => {
    const r = await linkLive(ctx.tenantId as Types.ObjectId, { ...body, by: ctx.userName });
    await audit(ctx, { action: 'live.linked', entity: 'LiveLink', after: { url: r.url } }, req);
    runLiveSync({ compare: true }).catch(() => undefined);
    return r;
  },
);

m.route({ method: 'post', path: '/sync', summary: 'Send changes to the live server now', auth: 'tenant', permission: P.SETTINGS_MANAGE }, async ({ ctx }) => {
  if (!(await LiveLink.exists({ tenantId: ctx.tenantId }))) throw badRequest('This server is not linked to a live server');
  runLiveSync({ compare: true }).catch(() => undefined);
  return { started: true };
});

m.route({ method: 'delete', path: '/connect', summary: 'Stop sending data to the live server', auth: 'tenant', permission: P.SETTINGS_MANAGE }, async ({ ctx, req }) => {
  await unlinkLive(ctx.tenantId as Types.ObjectId);
  await audit(ctx, { action: 'live.unlinked', entity: 'LiveLink' }, req);
  return { ok: true };
});

// ---------------------------------------------------------------------------------------------------------------------
// On the live server: receiving from the restaurant's server
// ---------------------------------------------------------------------------------------------------------------------

/** The local server proves itself with the key handed out by /live/link. */
async function liveKey(req: Request, res: Response, next: NextFunction) {
  try {
    const key = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1] ?? '';
    const mirror = await LiveMirror.findOne({}).lean();
    if (!mirror || !key || !safeEqual(sha256(key), mirror.keyHash)) throw new AppError(401, 'LIVE_KEY_INVALID', 'This server is no longer linked to the live server — link it again in Settings → Live server');
    res.locals.businessId = mirror.businessId;
    next();
  } catch (e) {
    next(e);
  }
}
function parseEjson(body: unknown) {
  if (typeof body !== 'string' || !body) throw badRequest('Expected an EJSON body');
  try {
    return EJSON.parse(body, { relaxed: false }) as Record<string, unknown>;
  } catch {
    throw badRequest('Invalid EJSON body');
  }
}

m.route(
  {
    method: 'post', path: '/link', summary: 'Live server: accept a link from a restaurant server (setup token)', auth: 'public',
    body: z.object({ setupToken: z.string().min(1).max(300), businessId: z.string().regex(/^[a-f0-9]{24}$/i), businessName: z.string().max(200), sourceName: z.string().max(200).optional(), replaceEmpty: z.boolean().optional() }),
  },
  async ({ body }) => {
    if (!env.SETUP_TOKEN) throw new AppError(403, 'SETUP_DISABLED', 'The live server has no SETUP_TOKEN set (see /etc/chili-pos/chili.env)');
    if (!safeEqual(body.setupToken, env.SETUP_TOKEN)) {
      await new Promise((r) => setTimeout(r, 1_000));
      throw new AppError(403, 'SETUP_TOKEN_INVALID', 'Wrong setup token for the live server');
    }
    const businessId = new Types.ObjectId(body.businessId);
    const existing = await Business.findOne({ singleton: 'business' }).lean();
    if (existing && !existing._id.equals(businessId)) {
      // The live server was set up on its own. It may only be replaced while it has no sales at all.
      const sales = (await Order.countDocuments({ tenantId: existing._id })) + (await Payment.countDocuments({ tenantId: existing._id }));
      if (!body.replaceEmpty || sales > 0) {
        throw new AppError(409, 'LIVE_HAS_OTHER_BUSINESS', sales > 0
          ? `The live server already runs its own business "${existing.name}" with sales. Use a fresh live server for the copy.`
          : `The live server was set up separately as "${existing.name}" (no sales yet). Replace it with this restaurant's data?`, { name: existing.name, canReplace: sales === 0 });
      }
      await withTransaction(async (session) => {
        for (const model of Object.values(mongoose.models)) {
          if (model.schema.path('tenantId')) await model.deleteMany({ tenantId: existing._id }).session(session);
        }
        await RefreshToken.deleteMany({}).setOptions({ skipTenantGuard: true }).session(session);
        await Business.deleteOne({ _id: existing._id }).session(session);
      });
      logger.warn({ replaced: existing.name }, 'Live server: empty separate business replaced by a linked restaurant');
    }
    const key = randomToken(32);
    await LiveMirror.updateOne({ singleton: 'mirror' }, { $set: { businessId, keyHash: sha256(key), sourceName: body.sourceName, linkedAt: new Date() } }, { upsert: true });
    forgetLiveCopyCache();
    logger.info({ source: body.sourceName, business: body.businessName }, 'Live server: restaurant server linked');
    return { key, name: existing?.name ?? body.businessName };
  },
);

m.route({ method: 'post', path: '/push', summary: 'Live server: receive changed documents', auth: 'public', middleware: [ejsonBody, liveKey] }, async ({ body, res }) => {
  const businessId = res.locals.businessId as Types.ObjectId;
  const { batches } = parseEjson(body) as { batches?: Array<{ c?: string; docs?: Array<Record<string, unknown>> }> };
  if (!Array.isArray(batches)) throw badRequest('batches is required');
  const refetch: Array<{ c: string; id: string }> = [];
  let n = 0;
  for (const b of batches) {
    const spec = specFor(String(b.c));
    if (!spec || !Array.isArray(b.docs)) throw badRequest(`Unknown collection ${String(b.c)}`);
    const scope = scopeOf(spec.collection, businessId);
    for (const raw of b.docs) {
      const id = raw?._id;
      if (!(id instanceof Types.ObjectId)) throw badRequest('Every document needs an ObjectId _id');
      // Only the linked business's documents are accepted.
      const owner = spec.collection === 'tenants' ? id : raw.tenantId;
      if (!(owner instanceof Types.ObjectId) || !owner.equals(businessId)) throw new AppError(403, 'LIVE_WRONG_BUSINESS', 'Document belongs to another business');
      const doc = incoming(spec.collection, raw as never);
      for (let attempt = 0; ; attempt++) {
        try {
          await coll(spec.collection).replaceOne({ ...scope, _id: id }, doc, { upsert: true });
          break;
        } catch (e) {
          const dup = e as { code?: number; keyValue?: Record<string, unknown> };
          if (dup.code !== 11000 || !dup.keyValue || attempt > 0) throw e;
          // A unique value (an order number, an open drawer) moved to this document: drop the stale holder here and
          // ask the restaurant server to send it again in its current state.
          const other = await coll(spec.collection).findOneAndDelete({ ...scope, ...dup.keyValue, _id: { $ne: id } });
          if (!other) throw e;
          refetch.push({ c: spec.collection, id: String(other._id) });
        }
      }
      n++;
    }
  }
  await LiveMirror.updateOne({ singleton: 'mirror' }, { $set: { lastPushAt: new Date() }, $inc: { docsReceived: n } });
  return { received: n, refetch };
});

m.route({ method: 'post', path: '/compare', summary: 'Live server: compare ids and timestamps, remove deleted documents', auth: 'public', middleware: [ejsonBody, liveKey] }, async ({ body, res }) => {
  const businessId = res.locals.businessId as Types.ObjectId;
  const { c, after, upTo, items } = parseEjson(body) as { c?: string; after?: Types.ObjectId | null; upTo?: Types.ObjectId | null; items?: Array<[Types.ObjectId, number | null]> };
  const spec = specFor(String(c));
  if (!spec || !Array.isArray(items)) throw badRequest('c and items are required');
  const range: Record<string, Types.ObjectId> = {};
  if (after instanceof Types.ObjectId) range.$gt = after;
  if (upTo instanceof Types.ObjectId) range.$lte = upTo;
  const filter = { ...scopeOf(spec.collection, businessId), ...(Object.keys(range).length ? { _id: range } : {}) };
  const here = new Map<string, number | null>();
  for (const d of await coll(spec.collection).find(filter, { projection: { _id: 1, [spec.ts]: 1 } }).toArray()) here.set(String(d._id), (d[spec.ts] as Date | undefined)?.getTime() ?? null);
  const need: string[] = [];
  const there = new Set<string>();
  for (const [id, ts] of items) {
    const k = String(id);
    there.add(k);
    // Canonical EJSON turns numbers into Double/Int32 wrappers; compare plain numbers.
    if (!here.has(k) || here.get(k) !== (ts == null ? null : Number(ts))) need.push(k);
  }
  let removed = 0;
  if (!spec.appendOnly) {
    const gone = [...here.keys()].filter((k) => !there.has(k)).map((k) => new Types.ObjectId(k));
    if (gone.length) removed = (await coll(spec.collection).deleteMany({ ...scopeOf(spec.collection, businessId), _id: { $in: gone } })).deletedCount;
  }
  return { need, removed };
});

m.route(
  { method: 'put', path: '/uploads/:name', summary: 'Live server: receive an uploaded image', auth: 'public', middleware: [express.raw({ type: 'application/octet-stream', limit: `${env.MAX_UPLOAD_MB}mb` }), liveKey] },
  async ({ params, req, res }) => {
    const name = params.name;
    if (!UPLOAD_NAME.test(name) || !Buffer.isBuffer(req.body)) throw badRequest('Invalid upload');
    const dir = path.resolve(env.UPLOAD_DIR, String(res.locals.businessId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), req.body);
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// On the live server: read-only
// ---------------------------------------------------------------------------------------------------------------------

/** What still works on a read-only live copy: signing in and out, and the link itself. */
const ALLOWED_ON_COPY = /^\/api\/v1\/(auth\/(login|refresh|logout|pin-login)|live\/(link|push|compare|uploads\/[^/]+)|display\/claim)$/;

/** On a live copy, every change must be made on the restaurant's server (it would be overwritten otherwise). */
export async function liveCopyGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.path.startsWith('/api/') || ALLOWED_ON_COPY.test(req.path)) return next();
    if (await isLiveCopy()) throw new AppError(409, 'LIVE_COPY_READ_ONLY', 'This is the live copy of the restaurant — view only. Make changes on the restaurant\'s own server.');
    next();
  } catch (e) {
    next(e);
  }
}

export default m;
