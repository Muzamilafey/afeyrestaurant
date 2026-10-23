/**
 * First-run setup — INTEGRATION tests against a real single-node replica set (mongodb-memory-server, or
 * MONGODB_TEST_URI). Transactions, rollback, unique indexes and concurrency are exercised for real.
 * Tests marked [unit/mock] replace one call with a mock to simulate a failure that cannot be produced on demand.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectDb, ensureIndexes } from '../src/db/connect';
import { getCapabilities } from '../src/db/capabilities';
import { createApp } from '../src/app';
import { Business, TaxRate, User } from '../src/models';
import { SYSTEM_ROLES } from '../src/auth/permissions';

const app = createApp();
const api = () => request(app);

const valid = (over: { email?: string; name?: string } = {}) => ({
  name: over.name ?? 'Afey Restaurant',
  contactPhone: '0712345678',
  branch: { name: 'Main', code: 'main' },
  owner: { name: 'Owner One', email: over.email ?? 'owner@afey.co.ke', password: 'Str0ng#Passw0rd!' },
});

const count = (coll: string) => mongoose.connection.db!.collection(coll).countDocuments();
const counts = async () => ({
  businesses: await count('tenants'),
  branches: await count('branches'),
  roles: await count('roles'),
  users: await count('users'),
  taxes: await count('taxrates'),
});
const EMPTY = { businesses: 0, branches: 0, roles: 0, users: 0, taxes: 0 };
const COMPLETE = { businesses: 1, branches: 1, roles: Object.keys(SYSTEM_ROLES).length, users: 1, taxes: 2 };

/** Responses must never leak driver errors, stack traces or internals. */
function expectSanitized(body: unknown) {
  const text = JSON.stringify(body);
  for (const leak of ['MongoServerError', 'Mongoose', 'stack', 'Transaction numbers', 'at async', 'node_modules', 'E11000', 'codeName']) {
    expect(text).not.toContain(leak);
  }
}

beforeAll(async () => {
  const u = new URL(process.env.MONGODB_TEST_URI!);
  u.pathname = `/chili_setup_${randomUUID().slice(0, 8)}`;
  await connectDb(u.toString());
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeAll(() => ensureIndexes());
// Empty every collection but keep them (and their unique indexes) — each test starts from a fresh, un-set-up install.
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
});
afterEach(() => vi.restoreAllMocks());

describe('database deployment', () => {
  it('is detected as a replica set with transactions', () => {
    const caps = getCapabilities()!;
    expect(caps.deployment).toBe('replicaSet');
    expect(caps.isWritablePrimary).toBe(true);
    expect(caps.transactions).toBe(true);
  });

  it('readiness probe reports database and transactions ok', async () => {
    const res = await api().get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', database: 'ok', transactions: 'ok' });
  });
});

describe('POST /api/v1/setup', () => {
  it('creates the business, branch, roles, owner and taxes exactly once', async () => {
    expect((await api().get('/api/v1/business')).body.data.configured).toBe(false);
    const res = await api().post('/api/v1/setup').send(valid());
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ ok: true });
    expect(await counts()).toEqual(COMPLETE);

    const b = await Business.findOne({ singleton: 'business' }).lean();
    expect(b!.name).toBe('Afey Restaurant');
    expect(b!.setupCompletedAt).toBeInstanceOf(Date);
    const owner = await User.findOne({ tenantId: b!._id, email: 'owner@afey.co.ke' }).select('+passwordHash').lean();
    expect(owner!.passwordHash).toMatch(/^\$argon2id\$/); // stored hashed
    expect((await api().get('/api/v1/business')).body.data).toMatchObject({ configured: true, name: 'Afey Restaurant' });

    // The owner can sign in straight away.
    const login = await api().post('/api/v1/auth/login').send({ email: 'owner@afey.co.ke', password: 'Str0ng#Passw0rd!' });
    expect(login.status).toBe(200);
  });

  it('a repeated submission is rejected with 409 and changes nothing', async () => {
    expect((await api().post('/api/v1/setup').send(valid())).status).toBe(201);
    const again = await api().post('/api/v1/setup').send(valid());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SET_UP');
    const other = await api().post('/api/v1/setup').send(valid({ email: 'someone@else.co', name: 'Hijack Bar' }));
    expect(other.status).toBe(409);
    expect(await counts()).toEqual(COMPLETE);
    expect((await Business.findOne({ singleton: 'business' }).lean())!.name).toBe('Afey Restaurant');
  });

  it('concurrent submissions: exactly one succeeds, the rest get 409, no duplicates or orphans', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api().post('/api/v1/setup').send(valid({ email: `owner${i}@afey.co.ke`, name: `Afey ${i}` }))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    for (const r of results) if (r.status === 409) expect(r.body.error.code).toBe('ALREADY_SET_UP');
    expect(await counts()).toEqual(COMPLETE);
    // Everything that exists belongs to the one business.
    const b = await Business.findOne({ singleton: 'business' }).lean();
    for (const coll of ['branches', 'roles', 'users', 'taxrates']) {
      expect(await mongoose.connection.db!.collection(coll).countDocuments({ tenantId: { $ne: b!._id } })).toBe(0);
    }
  });

  it('[unit/mock] a failure part-way through rolls everything back, and a retry then succeeds', async () => {
    vi.spyOn(TaxRate, 'create').mockRejectedValueOnce(new Error('disk full (simulated)'));
    const res = await api().post('/api/v1/setup').send(valid());
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    expect(res.body.error.requestId).toBeTruthy();
    expectSanitized(res.body);
    // Business, branch, roles and owner were written inside the transaction before the failure — all rolled back.
    expect(await counts()).toEqual(EMPTY);
    expect((await api().get('/api/v1/business')).body.data.configured).toBe(false);

    const retry = await api().post('/api/v1/setup').send(valid());
    expect(retry.status).toBe(201);
    expect(await counts()).toEqual(COMPLETE);
  });

  it('ends the database session after success and after failure', async () => {
    const sessions: mongoose.ClientSession[] = [];
    const real = mongoose.startSession.bind(mongoose);
    vi.spyOn(mongoose, 'startSession').mockImplementation((async (...args: Parameters<typeof mongoose.startSession>) => {
      const s = await real(...args);
      sessions.push(s);
      return s;
    }) as typeof mongoose.startSession);
    vi.spyOn(TaxRate, 'create').mockRejectedValueOnce(new Error('simulated'));
    expect((await api().post('/api/v1/setup').send(valid())).status).toBe(500);
    expect((await api().post('/api/v1/setup').send(valid())).status).toBe(201);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(s.hasEnded).toBe(true);
      expect(s.inTransaction()).toBe(false);
    }
  });

  it.each([
    ['missing business name', { ...valid(), name: '' }],
    ['invalid email', { ...valid(), owner: { ...valid().owner, email: 'not-an-email' } }],
    ['short password', { ...valid(), owner: { ...valid().owner, password: 'short' } }],
    ['weak password (policy)', { ...valid(), owner: { ...valid().owner, password: 'alllowercaseletters' } }],
    ['bad branch code', { ...valid(), branch: { name: 'Main', code: 'has space' } }],
    ['missing owner', { name: 'Afey', branch: { name: 'Main', code: 'MAIN' } }],
    ['operator injection', { ...valid(), name: { $gt: '' } }],
  ])('rejects invalid input (%s) with 400 and writes nothing', async (_label, body) => {
    const res = await api().post('/api/v1/setup').send(body);
    expect(res.status).toBe(400);
    expectSanitized(res.body);
    expect(await counts()).toEqual(EMPTY);
  });

  it('unique indexes reject duplicate identifiers at the database level', async () => {
    expect((await api().post('/api/v1/setup').send(valid())).status).toBe(201);
    const b = await Business.findOne({ singleton: 'business' }).lean();
    // A second business document is impossible, even bypassing the service.
    await expect(Business.create({ name: 'Second' })).rejects.toMatchObject({ code: 11000 });
    // Owner email is unique within the business (case-insensitive because emails are stored lower-cased).
    const owner = await User.findOne({ tenantId: b!._id }).lean();
    await expect(User.create({ tenantId: b!._id, email: 'owner@afey.co.ke', name: 'Copy', passwordHash: 'x', roleId: owner!.roleId })).rejects.toMatchObject({ code: 11000 });
    expect(await counts()).toEqual(COMPLETE);
  });

  it('[unit/mock] database unreachable → 503 DATABASE_UNAVAILABLE with a sanitized body', async () => {
    const err = Object.assign(new Error('Server selection timed out after 10000 ms'), { name: 'MongoServerSelectionError' });
    vi.spyOn(Business, 'findOne').mockImplementation(() => ({ lean: () => Promise.reject(err) }) as never);
    const res = await api().post('/api/v1/setup').send(valid());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expectSanitized(res.body);
    expect(res.body.error.message).not.toContain('10000');
  });
});

describe('GET /api/v1/manifest.webmanifest (PWA)', () => {
  it('serves an installable manifest named after the business', async () => {
    const before = await api().get('/api/v1/manifest.webmanifest');
    expect(before.status).toBe(200);
    expect(before.headers['content-type']).toContain('application/manifest+json');
    expect(before.body).toMatchObject({ name: 'Chili POS', start_url: '/', display: 'standalone' });
    const sizes = before.body.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192/any', '512x512/any', '512x512/maskable']));

    expect((await api().post('/api/v1/setup').send(valid({ name: 'Afey Restaurant & Grill' }))).status).toBe(201);
    const after = await api().get('/api/v1/manifest.webmanifest');
    expect(after.body.name).toBe('Afey Restaurant & Grill');
    expect(after.body.short_name.length).toBeLessThanOrEqual(12);

    // The business logo becomes the app icon once its PNG icons are saved.
    const login = await api().post('/api/v1/auth/login').send({ email: 'owner@afey.co.ke', password: 'Str0ng#Passw0rd!' });
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}`, 'X-Requested-With': 'chili-pos' };
    const base = '/uploads/' + '0123456789abcdef01234567' + '/';
    const icons = { icon192: `${base}a-192.png`, icon512: `${base}a-512.png`, maskable512: `${base}a-m.png`, source: `${base}logo.png` };
    const bad = await api().patch('/api/v1/admin/tenant').set(auth).send({ branding: { appIcons: { ...icons, icon192: 'https://evil.example/x.png' } } });
    expect(bad.status).toBe(400);
    expect((await api().patch('/api/v1/admin/tenant').set(auth).send({ branding: { logoUrl: icons.source, appIcons: icons } })).status).toBe(200);
    const branded = await api().get('/api/v1/manifest.webmanifest');
    expect(branded.body.icons.map((i: { src: string }) => i.src)).toEqual([icons.icon192, icons.icon512, icons.maskable512]);
    expect((await api().get('/api/v1/business')).body.data.icons).toMatchObject({ icon192: icons.icon192 });
    // Removing the logo goes back to the Chili POS icons.
    expect((await api().patch('/api/v1/admin/tenant').set(auth).send({ branding: { logoUrl: '', appIcons: null } })).status).toBe(200);
    expect((await api().get('/api/v1/manifest.webmanifest')).body.icons[0].src).toBe('/icon-192.png');
  });
});
