import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { AuditLog, Branch, Product } from '../src/models';
import { dayRange, localDate } from '../src/lib/time';

let seed: Awaited<ReturnType<typeof setupDb>>;
let cashier: Session;
let manager: Session;
let coke = '';

describe('end of day (X / Z report)', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [cashier, manager] = await Promise.all([login('cashier@chili.demo'), login('manager@chili.demo')]);
    coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 100000 }));
  });
  afterAll(teardownDb);

  it('business day boundaries follow the business time zone', () => {
    const { start, end } = dayRange('2026-10-25', 'Africa/Nairobi');
    expect(start.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T21:00:00.000Z');
    expect(localDate('Africa/Nairobi', new Date('2026-10-24T21:30:00Z'))).toBe('2026-10-25');
  });

  it('adds up the day, closes it, keeps the closed figures, and sends it', async () => {
    const sale = async (body: Record<string, unknown>) => {
      const o = (await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 1 }] }))).body.data;
      const r = await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ amount: o.totals.total, idempotencyKey: uuid(), ...body }));
      expect(r.status).toBe(201);
      return o.totals.total as number;
    };
    const a = await sale({ method: 'cash', tip: 2000, tendered: 50000 });
    const b = await sale({ method: 'mpesa_manual' });
    await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 1 }] })); // left open

    const x = await manager.as(api().get('/api/v1/day-close'));
    expect(x.status).toBe(200);
    expect(x.body.data.closed).toBeNull();
    const z = x.body.data.report;
    expect(z.sales).toMatchObject({ gross: a + b, orders: 2 });
    expect(z.payments.map((p: { label: string }) => p.label).sort()).toEqual(['Cash', 'M-Pesa (manual)']);
    expect(z.tips).toMatchObject({ cash: 2000, total: 2000 });
    expect(z.attention).toMatchObject({ openOrders: 1, manualMpesa: 1 });
    expect(z.drawers[0]).toMatchObject({ status: 'open', expected: 100000 + a + 2000 });
    expect(x.body.data.doc.lines.some((l: { t?: string }) => l.t === 'X REPORT (DAY NOT CLOSED)')).toBe(true);

    expect((await cashier.as(api().post('/api/v1/day-close/close').send({}))).status).toBe(403); // managers close the day
    const closed = await manager.as(api().post('/api/v1/day-close/close').send({}));
    expect(closed.status).toBe(200);
    expect(closed.body.data.closed.timesClosed).toBe(1);
    expect(closed.body.data.doc.lines.some((l: { t?: string }) => l.t === 'END OF DAY - Z REPORT')).toBe(true);
    expect(await AuditLog.exists({ tenantId: seed.tenantId, action: 'day.closed' })).toBeTruthy();

    // A later sale doesn't change the closed figures (unless asked for live figures, or the day is closed again).
    const c = await sale({ method: 'cash' });
    const after = await manager.as(api().get('/api/v1/day-close'));
    expect(after.body.data.report.sales.gross).toBe(a + b);
    expect((await manager.as(api().get('/api/v1/day-close?live=1'))).body.data.report.sales.gross).toBe(a + b + c);
    const again = await manager.as(api().post('/api/v1/day-close/close').send({}));
    expect(again.body.data).toMatchObject({ closed: { timesClosed: 2 }, report: { sales: { gross: a + b + c } } });

    const noOne = await manager.as(api().post('/api/v1/day-close/send').send({ channel: 'sms', to: undefined }));
    expect([200, 400]).toContain(noOne.status);
    const sent = await manager.as(api().post('/api/v1/day-close/send').send({ channel: 'email', to: 'owner@example.com' }));
    expect(sent.body.data.sent).toEqual(['owner@example.com']);
  });
});
