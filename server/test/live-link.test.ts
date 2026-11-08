import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { api, login, setupDb, teardownDb } from './helpers';
import { env } from '../src/config/env';
import { Category, LiveMirror } from '../src/models';
import { forgetLiveCopyCache } from '../src/services/liveSync';

const EJSON = mongoose.mongo.BSON.EJSON;
const TOKEN = 'live-test-setup-token';
let seed: Awaited<ReturnType<typeof setupDb>>;
let key = '';
const ejson = (path: string, body: unknown, k = key) =>
  api().post(`/api/v1/live/${path}`).set('Authorization', `Bearer ${k}`).set('Content-Type', 'application/ejson').send(EJSON.stringify(body, { relaxed: false }));

// This database plays the live server; the requests play the restaurant's server sending its data.
describe('live server copy', () => {
  beforeAll(async () => {
    seed = await setupDb();
    env.SETUP_TOKEN = TOKEN;
  });
  afterAll(async () => {
    env.SETUP_TOKEN = '';
    forgetLiveCopyCache();
    await teardownDb();
  });

  it('accepts a link only with the setup token, and never over a different business', async () => {
    const tenantId = String(seed.tenantId);
    const wrong = await api().post('/api/v1/live/link').send({ setupToken: 'nope', businessId: tenantId, businessName: 'x' });
    expect(wrong.status).toBe(403);
    const other = await api().post('/api/v1/live/link').send({ setupToken: TOKEN, businessId: String(new Types.ObjectId()), businessName: 'Another place' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('LIVE_HAS_OTHER_BUSINESS');
    expect(await LiveMirror.exists({})).toBeNull();

    const ok = await api().post('/api/v1/live/link').send({ setupToken: TOKEN, businessId: tenantId, businessName: 'Chili', sourceName: 'till-pc' });
    expect(ok.status).toBe(200);
    key = ok.body.data.key;
    expect(key.length).toBeGreaterThan(30);
    forgetLiveCopyCache();
  });

  it('stores pushed documents, refuses other businesses and bad keys', async () => {
    const _id = new Types.ObjectId();
    const now = new Date();
    const r = await ejson('push', { batches: [{ c: 'categories', docs: [{ _id, tenantId: seed.tenantId, name: 'Pushed from till', sortOrder: 9, active: true, createdAt: now, updatedAt: now }] }] });
    expect(r.status).toBe(200);
    expect(r.body.data.received).toBe(1);
    expect((await Category.findOne({ tenantId: seed.tenantId, _id }).lean())?.name).toBe('Pushed from till');

    const foreign = await ejson('push', { batches: [{ c: 'categories', docs: [{ _id: new Types.ObjectId(), tenantId: new Types.ObjectId(), name: 'x' }] }] });
    expect(foreign.status).toBe(403);
    const excluded = await ejson('push', { batches: [{ c: 'refreshtokens', docs: [] }] });
    expect(excluded.status).toBe(400);
    const badKey = await ejson('push', { batches: [] }, 'not-the-key');
    expect(badKey.status).toBe(401);
  });

  it('moves a unique value to its new holder and asks for the old one again', async () => {
    const [a, b] = await Category.find({ tenantId: seed.tenantId }).sort({ _id: 1 }).limit(2).lean();
    // On the till, b took a's (unique) name; a was renamed but that change is not here yet.
    const r = await ejson('push', { batches: [{ c: 'categories', docs: [{ ...b, name: a.name }] }] });
    expect(r.status).toBe(200);
    expect(r.body.data.refetch).toEqual([{ c: 'categories', id: String(a._id) }]);
    expect((await Category.findOne({ tenantId: seed.tenantId, _id: b._id }).lean())?.name).toBe(a.name);
  });

  it('compare lists what is missing or changed and removes what the till deleted', async () => {
    const docs = (await Category.find({ tenantId: seed.tenantId }).sort({ _id: 1 }).lean()) as Array<{ _id: Types.ObjectId; updatedAt: Date }>;
    const [gone, changed, ...same] = docs;
    const missing = new Types.ObjectId();
    const items = [[changed._id, changed.updatedAt.getTime() + 1], ...same.map((d) => [d._id, d.updatedAt.getTime()]), [missing, Date.now()]].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    const r = await ejson('compare', { c: 'categories', after: null, upTo: null, items });
    expect(r.status).toBe(200);
    expect(r.body.data.need.sort()).toEqual([String(changed._id), String(missing)].sort());
    expect(r.body.data.removed).toBe(1);
    expect(await Category.exists({ tenantId: seed.tenantId, _id: gone._id })).toBeNull();
  });

  it('is read-only for users, but sign-in still works', async () => {
    const owner = await login('owner@chili.demo');
    const write = await owner.as(api().patch('/api/v1/admin/tenant').send({ name: 'Changed on the copy' }));
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe('LIVE_COPY_READ_ONLY');
    const read = await owner.as(api().get('/api/v1/admin/tenant'));
    expect(read.status).toBe(200);
    const status = await owner.as(api().get('/api/v1/live/status'));
    expect(status.body.data.role).toBe('live');
    const pub = await api().get('/api/v1/business');
    expect(pub.body.data.liveCopy).not.toBeNull();
  });
});
