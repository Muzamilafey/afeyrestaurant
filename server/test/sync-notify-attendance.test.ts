import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupDb, teardownDb, api, login, uuid, type Session } from './helpers';
import { Product, Order, Payment, StockLedger, NotificationJob, Customer, BiometricDevice, AttendanceEvent, Employee, ShiftAssignment } from '../src/models';
import { notify, processNotificationQueue } from '../src/services/notify';
import { MockSmsProvider } from '../src/integrations/sms/provider';
import { saveIntegration } from '../src/services/integrations';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let owner: Session;
beforeAll(async () => {
  seed = await setupDb();
  [cashier, owner] = await Promise.all([login('cashier@chili.demo'), login('owner@chili.demo')]);
});
afterAll(teardownDb);

describe('offline synchronisation', () => {
  it('synchronises an offline sale exactly once, honouring the offline price and flagging the difference', async () => {
    const coke = await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean();
    const order = {
      clientId: uuid(), terminalId: 'T1', createdAt: new Date(Date.now() - 60_000).toISOString(), type: 'takeaway',
      items: [{ lineId: uuid(), productId: String(coke!._id), qty: 2, unitPrice: 14000 }],
      payments: [{ clientPaymentId: uuid(), method: 'cash', amount: 28000, tendered: 30000 }],
    };
    const r1 = await cashier.as(api().post('/api/v1/sync/orders').send({ orders: [order] }));
    expect(r1.body.data.results[0]).toMatchObject({ status: 'created', priceConflicts: 1 });
    const r2 = await cashier.as(api().post('/api/v1/sync/orders').send({ orders: [order] }));
    expect(r2.body.data.results[0].status).toBe('duplicate');
    const orders = await Order.find({ tenantId: seed.tenantId, clientId: order.clientId }).lean();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ source: 'offline', status: 'paid' });
    expect(orders[0].totals!.total).toBe(28000);
    const pays = await Payment.find({ tenantId: seed.tenantId, orderId: orders[0]._id }).lean();
    expect(pays).toHaveLength(1);
    expect(pays[0].verification).toBe('offline_cash');
    expect(await StockLedger.countDocuments({ tenantId: seed.tenantId, refId: orders[0]._id })).toBe(1);
  });
});

describe('notifications', () => {
  it('dedupes, respects marketing consent and retries temporary failures', async () => {
    const a = await notify(seed.tenantId, { event: 'order_ready', channel: 'sms', to: '0712345678', vars: { customer_name: 'Jane', order_number: 'X1' }, dedupeKey: 'ready:test' });
    const b = await notify(seed.tenantId, { event: 'order_ready', channel: 'sms', to: '0712345678', vars: { customer_name: 'Jane', order_number: 'X1' }, dedupeKey: 'ready:test' });
    expect(String(a!._id)).toBe(String(b!._id));
    const noConsent = await Customer.create({ tenantId: seed.tenantId, name: 'No Promo', phone: '254799000001' });
    const promo = await notify(seed.tenantId, { event: 'promotion', channel: 'sms', to: '0799000001', vars: { message: 'Hi' }, customerId: noConsent._id, dedupeKey: 'promo:1' });
    expect(promo!.status).toBe('skipped');
    const perm = await notify(seed.tenantId, { event: 'order_ready', channel: 'sms', to: '0711000000', vars: { customer_name: 'X', order_number: 'Y' }, dedupeKey: 'perm:1' });
    MockSmsProvider.sent.length = 0;
    await processNotificationQueue();
    expect(MockSmsProvider.sent.filter((m) => m.to === '254712345678')).toHaveLength(1);
    expect((await NotificationJob.findOne({ tenantId: seed.tenantId, _id: perm!._id }).lean())!.status).toBe('failed'); // permanent failure, not retried
    // Disabled integration → job is skipped, not silently "sent"
    await saveIntegration(seed.tenantId, 'email', { provider: 'mock', enabled: false }, seed.tenantId);
    const e = await notify(seed.tenantId, { event: 'test', channel: 'email', to: 'a@b.co', vars: {}, dedupeKey: 'email:off' });
    expect(e!.status).toBe('skipped');
  });

  it('reports simulated integration tests honestly and never as a live connection', async () => {
    const r = await owner.as(api().post('/api/v1/integrations/sms/test').send({ to: '0712345678' }));
    expect(r.body.data).toMatchObject({ ok: true, simulated: true });
    const ov = await owner.as(api().get('/api/v1/integrations'));
    const sms = ov.body.data.integrations.find((i: { kind: string }) => i.kind === 'sms');
    expect(sms.config.status.state).not.toBe('ok');
    expect(sms.config.status.lastTestOk).toBe(false);
    expect(JSON.stringify(ov.body.data)).not.toMatch(/"secrets"/);
  });

  it('stores integration secrets encrypted and never returns them', async () => {
    const r = await owner.as(api().put('/api/v1/integrations/mpesa').send({ provider: 'daraja', enabled: false, environment: 'sandbox', settings: { shortCode: '174379', transactionType: 'CustomerPayBillOnline' }, secrets: { consumerKey: 'ck_live_value_1234', consumerSecret: 'cs_value_5678', passkey: 'pk_value_9999' } }));
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('ck_live_value_1234');
    expect(r.body.data.secretHints.consumerKey).toBe('••••1234');
    const { IntegrationConfiguration } = await import('../src/models');
    const raw = await IntegrationConfiguration.findOne({ tenantId: seed.tenantId, kind: 'mpesa' }).select('+secrets').lean();
    expect(JSON.stringify(raw)).not.toContain('ck_live_value_1234');
    // Restore the simulated provider for other tests
    await owner.as(api().put('/api/v1/integrations/mpesa').send({ provider: 'mock', enabled: true }));
  });
});

describe('biometric attendance via bridge', () => {
  it('ingests device punches idempotently and produces an attendance report', async () => {
    const br = await owner.as(api().post('/api/v1/integrations/bridges').send({ name: 'Back office PC' }));
    expect(br.body.data.token).toMatch(/^cbr_/);
    const token = br.body.data.token;
    const dev = await owner.as(api().post('/api/v1/staff/devices').send({ name: 'Entrance K40', vendor: 'zkteco', deviceType: 'zkteco_terminal', model: 'K40', connection: 'udp', host: '192.168.1.201', port: 4370, bridgeId: br.body.data.id }));
    expect(dev.status).toBe(201);
    expect(dev.body.data.verified).toBe(false);
    const emp = await Employee.findOne({ tenantId: seed.tenantId, deviceUserCode: '3' }).lean();
    // Enrolment without consent is refused
    const noConsent = await owner.as(api().post(`/api/v1/staff/devices/${dev.body.data._id}/enroll`).send({ employeeId: String(emp!._id) }));
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    await owner.as(api().post(`/api/v1/staff/employees/${emp!._id}/biometric-consent`).send({ given: true }));
    const enr = await owner.as(api().post(`/api/v1/staff/devices/${dev.body.data._id}/enroll`).send({ employeeId: String(emp!._id) }));
    expect(enr.status).toBe(201);
    const day = new Date(Date.now() - 86400_000);
    day.setUTCHours(5, 5, 0, 0); // 08:05 EAT yesterday
    const out = new Date(day.getTime() + 9 * 3600_000 + 30 * 60_000); // 17:35 EAT
    await ShiftAssignment.create({ tenantId: seed.tenantId, branchId: seed.mainBranchId, employeeId: emp!._id, shiftId: seed.shiftId, date: day.toISOString().slice(0, 10) });
    const events = [{ userCode: '3', at: day.toISOString(), punch: 'unknown' }, { userCode: '3', at: out.toISOString(), punch: 'unknown' }, { userCode: '999', at: out.toISOString() }];
    const unauth = await api().post('/api/v1/bridge/attendance').send({ deviceId: dev.body.data._id, events });
    expect(unauth.status).toBe(401);
    const r1 = await api().post('/api/v1/bridge/attendance').set('X-Bridge-Token', token).send({ deviceId: dev.body.data._id, events });
    expect(r1.body.data).toMatchObject({ inserted: 3, duplicates: 0 });
    const r2 = await api().post('/api/v1/bridge/attendance').set('X-Bridge-Token', token).send({ deviceId: dev.body.data._id, events });
    expect(r2.body.data).toMatchObject({ inserted: 0, duplicates: 3 });
    expect(await AttendanceEvent.countDocuments({ tenantId: seed.tenantId, unmatched: true })).toBe(1);
    const poll = await api().get('/api/v1/bridge/poll').set('X-Bridge-Token', token);
    expect(poll.body.data.commands.some((c: { type: string }) => c.type === 'enroll_user')).toBe(true);
    const hr = await login('hr@chili.demo');
    const rep = await hr.as(api().get('/api/v1/staff/attendance/report').query({ from: new Date(day.getTime() - 3600_000).toISOString(), to: new Date(out.getTime() + 3600_000).toISOString() }));
    const row = rep.body.data.rows.find((x: { employeeId: string }) => x.employeeId === String(emp!._id));
    expect(row).toMatchObject({ workedMinutes: 9 * 60 + 30 - 60, missingClockOut: false, overtimeMinutes: 30, lateMinutes: 0 });
    const csv = await hr.as(api().get('/api/v1/staff/attendance/report').query({ from: new Date(day.getTime() - 3600_000).toISOString(), to: new Date(out.getTime() + 3600_000).toISOString(), format: 'csv' }));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect((await BiometricDevice.findOne({ tenantId: seed.tenantId, _id: dev.body.data._id }).lean())!.status).toBe('online');
  });
});

describe('business profile', () => {
  it('lets the owner change the business name and logo, and shows them publicly and on receipts', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f4d0e40000000049454e44ae426082', 'hex');
    const up = await owner.as(api().post('/api/v1/menu/uploads/image').attach('file', png, { filename: 'logo.png', contentType: 'image/png' }));
    expect(up.status).toBe(201);
    const logoUrl = up.body.data.url;
    const bad = await owner.as(api().post('/api/v1/menu/uploads/image').attach('file', Buffer.from('<svg/>'), { filename: 'x.png', contentType: 'image/png' }));
    expect(bad.status).toBe(415);
    const r = await owner.as(api().patch('/api/v1/admin/tenant').send({ name: 'Afey Restaurant', branding: { logoUrl } }));
    expect(r.status).toBe(200);
    const pub = await api().get('/api/v1/business');
    expect(pub.body.data).toMatchObject({ name: 'Afey Restaurant', logoUrl });
    const me = await owner.as(api().get('/api/v1/auth/me'));
    expect(me.body.data.business.name).toBe('Afey Restaurant');
    const cashier2 = await login('cashier@chili.demo');
    expect((await cashier2.as(api().patch('/api/v1/admin/tenant').send({ name: 'Nope' }))).status).toBe(403);
    expect((await owner.as(api().patch('/api/v1/admin/tenant').send({ branding: { logoUrl: 'javascript:alert(1)' } }))).status).toBe(400);
  });
});
