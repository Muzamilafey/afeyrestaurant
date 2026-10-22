import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupDb, teardownDb, api, login, uuid, DEMO_PASSWORD } from './helpers';
import { setupBusiness } from '../src/services/setup';
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
      const r = await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: 'wrong'});
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe('Invalid email or password');
    }
    await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: 'wrong'});
    const locked = await api().post('/api/v1/auth/login').send({ email: 'auditor@chili.demo', password: DEMO_PASSWORD});
    expect(locked.status).toBe(423);
    await User.updateOne({ tenantId: seed.tenantId, email: 'auditor@chili.demo' }, { $unset: { lockedUntil: 1 } });
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'cashier@chili.demo', password: DEMO_PASSWORD});
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

describe('PIN sign-in', () => {
  it('works only on a registered terminal, with numeric PINs and lockout', async () => {
    const noTerminal = await api().get('/api/v1/auth/terminal/staff');
    expect(noTerminal.body.error.code).toBe('TERMINAL_REQUIRED');
    const cashier = await login('cashier@chili.demo');
    expect((await cashier.as(api().post('/api/v1/auth/terminal/register').send({ name: 'Till 1' }))).status).toBe(403);
    const manager = await login('manager@chili.demo');
    const reg = await manager.as(api().post('/api/v1/auth/terminal/register').send({ name: 'Till 1' }));
    expect(reg.status).toBe(201);
    const token = reg.body.data.terminalToken;
    const staff = await api().get('/api/v1/auth/terminal/staff').set('X-Terminal-Token', token);
    const waiter = staff.body.data.staff.find((s: { displayName: string }) => s.displayName === 'Wycliffe K.');
    expect(waiter).toMatchObject({ hasPin: true, role: 'Waiter' });
    expect(JSON.stringify(staff.body)).not.toMatch(/@chili\.demo|pinHash/);
    const ok = await api().post('/api/v1/auth/pin-login').set('X-Terminal-Token', token).send({ userId: waiter.id, pin: '2580' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
    expect(ok.body.data.permissions).toContain('orders.create');
    expect((await api().post('/api/v1/auth/pin-login').send({ userId: waiter.id, pin: '2580' })).status).toBe(401);
    expect((await api().post('/api/v1/auth/pin-login').set('X-Terminal-Token', token).send({ userId: waiter.id, pin: 'abcd' })).status).toBe(400);
    // Every user can change their own PIN (numbers only, not trivial).
    const w = { as: <T extends ReturnType<typeof api>['post']>(r: ReturnType<T>) => r.set('Authorization', `Bearer ${ok.body.data.accessToken}`) };
    expect((await w.as(api().post('/api/v1/auth/pin').send({ currentPin: '2580', pin: '1111' }))).body.error.message).toMatch(/same digit/);
    expect((await w.as(api().post('/api/v1/auth/pin').send({ currentPin: '2580', pin: '3456' }))).body.error.message).toMatch(/sequence/);
    expect((await w.as(api().post('/api/v1/auth/pin').send({ currentPin: '0000', pin: '7391' }))).status).toBe(400);
    expect((await w.as(api().post('/api/v1/auth/pin').send({ currentPin: '2580', pin: '7391' }))).status).toBe(200);
    expect((await api().post('/api/v1/auth/pin-login').set('X-Terminal-Token', token).send({ userId: waiter.id, pin: '7391' })).status).toBe(200);
    // Five wrong PINs lock the account.
    for (let i = 0; i < 5; i++) await api().post('/api/v1/auth/pin-login').set('X-Terminal-Token', token).send({ userId: waiter.id, pin: '9999' });
    const locked = await api().post('/api/v1/auth/pin-login').set('X-Terminal-Token', token).send({ userId: waiter.id, pin: '7391' });
    expect(locked.status).toBe(423);
    // A chef assigned to this branch appears; staff from other branches do not.
    expect(staff.body.data.staff.some((s: { role: string }) => s.role === 'Kitchen Staff / Chef')).toBe(true);
  });
});

describe('authorisation', () => {
  it('prevents a cashier from accessing restricted accounting functions', async () => {
    const cashier = await login('cashier@chili.demo');
    expect((await cashier.as(api().get('/api/v1/reports/profit-loss'))).status).toBe(403);
    expect((await cashier.as(api().get('/api/v1/reports/reconciliation'))).status).toBe(403);
    expect((await cashier.as(api().get('/api/v1/cash/expenses'))).status).toBe(403);
    expect((await cashier.as(api().put('/api/v1/integrations/mpesa').send({ provider: 'mock', enabled: true }))).status).toBe(403);
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

describe('data scoping & input hardening', () => {
  it('allows exactly one business per installation', async () => {
    await expect(setupBusiness({ name: 'Second Bar', branch: { name: 'Main', code: 'MAIN' }, owner: { name: 'Xavier', email: 'x@y.co', password: 'Another#2026xx' } })).rejects.toMatchObject({ code: 'ALREADY_SET_UP' });
    const r = await api().post('/api/v1/setup').send({ name: 'Hijack', branch: { name: 'Main', code: 'MAIN' }, owner: { name: 'Xavier', email: 'x@y.co', password: 'Another#2026xx' } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    const pub = await api().get('/api/v1/business');
    expect(pub.body.data).toMatchObject({ configured: true, name: 'Chili Grill & Lounge' });
  });

  it('enforces the tenant guard on unscoped queries', async () => {
    await expect(Order.find({ status: 'open' })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Order.aggregate([{ $match: { status: 'open' } }])).rejects.toBeInstanceOf(TenantGuardError);
    expect(mongoose.connection.readyState).toBe(1);
  });

  it('strips MongoDB operators from input', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: { $gt: '' }, password: { $gt: '' }});
    expect(r.status).toBe(400);
  });
});
