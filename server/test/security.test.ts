import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupDb, teardownDb, api, login, uuid, DEMO_PASSWORD } from './helpers';
import { createTenant } from '../src/services/tenantSetup';
import { Order, User, RefreshToken } from '../src/models';
import { TenantGuardError } from '../src/db/tenantGuard';

let seed: Awaited<ReturnType<typeof setupDb>>;
beforeAll(async () => {
  seed = await setupDb();
});
afterAll(teardownDb);

describe('authentication', () => {
  it('rejects bad credentials with a generic message and locks after repeated failures', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: 'wrong', tenantSlug: 'chili-demo' });
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe('Invalid email or password');
    }
    await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: 'wrong', tenantSlug: 'chili-demo' });
    const locked = await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: DEMO_PASSWORD, tenantSlug: 'chili-demo' });
    expect(locked.status).toBe(423);
    await User.updateOne({ tenantId: seed.tenantId, email: 'auditor@chili.demo' }, { $unset: { lockedUntil: 1 } });
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'cashier@chili.demo', password: DEMO_PASSWORD, tenantSlug: 'chili-demo' });
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const noCsrf = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(noCsrf.status).toBe(403);
    const r1 = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'chili-pos');
    expect(r1.status).toBe(200);
    const newCookie = r1.headers['set-cookie'][0].split(';')[0];
    // A concurrent refresh with the just-rotated token (two tabs) is rejected but does not end the session.
    const race = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'chili-pos');
    expect(race.status).toBe(401);
    const stillValid = await api().post('/api/v1/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'chili-pos');
    expect(stillValid.status).toBe(200);
    const latest = stillValid.headers['set-cookie'][0].split(';')[0];
    // Reuse after the grace window is treated as theft: the whole token family is revoked.
    await RefreshToken.updateMany({ revokedAt: { $ne: null } }, { $set: { revokedAt: new Date(Date.now() - 120_000) } });
    const reuse = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'chili-pos');
    expect(reuse.status).toBe(401);
    const afterRevoke = await api().post('/api/v1/auth/refresh').set('Cookie', latest).set('X-Requested-With', 'chili-pos');
    expect(afterRevoke.status).toBe(401); // whole family revoked
  });

  it('requires a token and rejects tampered tokens', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });
});

describe('authorisation', () => {
  it('prevents a cashier from accessing restricted accounting functions', async () => {
    const cashier = await login('cashier@chili.demo');
    expect((await cashier.as(api().get('/api/v1/reports/profit-loss'))).status).toBe(403);
    expect((await cashier.as(api().get('/api/v1/reports/reconciliation'))).status).toBe(403);
    expect((await cashier.as(api().get('/api/v1/cash/expenses'))).status).toBe(403);
    expect((await cashier.as(api().put('/api/v1/integrations/mpesa').send({ provider: 'mock', enabled: true }))).status).toBe(403);
    expect((await cashier.as(api().get('/api/v1/platform/tenants'))).status).toBe(403);
    const accountant = await login('accountant@chili.demo');
    expect((await accountant.as(api().get('/api/v1/reports/profit-loss'))).status).toBe(200);
  });

  it('keeps kitchen staff away from payments', async () => {
    const chef = await login('chef@chili.demo');
    expect((await chef.as(api().get('/api/v1/stations/kitchen/tickets'))).status).toBe(200);
    expect((await chef.as(api().get('/api/v1/stations/bar/tickets'))).status).toBe(403);
    expect((await chef.as(api().get('/api/v1/orders'))).status).toBe(403);
  });

  it('rejects branches the user is not assigned to', async () => {
    const cashier = await login('cashier@chili.demo', { branchId: String(seed.secondBranchId) });
    expect((await cashier.as(api().get('/api/v1/orders'))).status).toBe(403);
  });

  it('prevents privilege escalation through role assignment', async () => {
    const manager = await login('manager@chili.demo');
    const r = await manager.as(api().put('/api/v1/admin/roles/superuser').send({ key: 'superuser', name: 'x', permissions: ['settings.manage'], branchScoped: false }));
    expect(r.status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('prevents a user from accessing another tenant’s records', async () => {
    await createTenant({ name: 'Other Bar', slug: 'other-bar', planCode: 'growth', branch: { name: 'Main', code: 'MAIN' }, owner: { name: 'Other Owner', email: 'owner@other.bar', password: 'OtherBar#2026x' } });
    const other = await login('owner@other.bar', { tenantSlug: 'other-bar', password: 'OtherBar#2026x' });
    const owner = await login('owner@chili.demo');
    const created = await owner.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway' }));
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    expect((await other.as(api().get(`/api/v1/orders/${id}`))).status).toBe(404);
    const otherOwn = await login('owner@other.bar', { tenantSlug: 'other-bar', password: 'OtherBar#2026x' });
    const r = await api().get(`/api/v1/orders/${id}`).set('Authorization', `Bearer ${otherOwn.token}`);
    expect(r.status).toBe(404);
    // Branch header spoofing with another tenant's branch id
    const spoof = await api().get('/api/v1/orders').set('Authorization', `Bearer ${otherOwn.token}`).set('X-Branch-Id', owner.branchId);
    expect(spoof.status).toBe(403);
    // Same email/password cannot log into the wrong tenant
    const wrong = await api().post('/api/v1/auth/login').send({ email: 'owner@chili.demo', password: DEMO_PASSWORD, tenantSlug: 'other-bar' });
    expect(wrong.status).toBe(401);
  });

  it('enforces the tenant guard on unscoped queries', async () => {
    await expect(Order.find({ status: 'open' })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Order.aggregate([{ $match: { status: 'open' } }])).rejects.toBeInstanceOf(TenantGuardError);
    expect(mongoose.connection.readyState).toBe(1);
  });

  it('strips MongoDB operators from input', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: { $gt: '' }, password: { $gt: '' }, tenantSlug: 'chili-demo' });
    expect(r.status).toBe(400);
  });
});
