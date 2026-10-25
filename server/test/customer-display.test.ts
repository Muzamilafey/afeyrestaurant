import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, type Session } from './helpers';

let cashier: Session;

describe('customer display pairing', () => {
  beforeAll(async () => {
    await setupDb();
    cashier = await login('cashier@chili.demo');
  });
  afterAll(teardownDb);

  it('pairs a tablet with a one-time code and shows only what the till publishes', async () => {
    const p = await cashier.as(api().post('/api/v1/display/pair').send({ name: 'Counter tablet' }));
    expect(p.status).toBe(201);
    expect(p.body.data.code).toMatch(/^\d{6}$/);
    expect((await api().post('/api/v1/display/claim').send({ code: '000000' })).status).toBe(400);
    const c = await api().post('/api/v1/display/claim').send({ code: p.body.data.code });
    expect(c.status).toBe(200);
    const token = c.body.data.token as string;
    expect((await api().post('/api/v1/display/claim').send({ code: p.body.data.code })).status).toBe(400); // used once

    const empty = await api().get('/api/v1/display/screen').set('Authorization', `Display ${token}`);
    expect(empty.body.data).toMatchObject({ name: 'Counter tablet', state: null });
    expect(empty.body.data.business.name).toBeTruthy();

    const state = { stage: 'pay', lines: [{ name: 'Coke', qty: 2, total: 30000 }], subtotal: 30000, total: 30000, paid: 0, balance: 30000 };
    expect((await cashier.as(api().put(`/api/v1/display/screens/${p.body.data.pairingId}`).send({ state }))).status).toBe(200);
    const shown = await api().get('/api/v1/display/screen').set('Authorization', `Display ${token}`);
    expect(shown.body.data.state).toEqual(state);

    // The display token can't do anything else, and unpairing ends it.
    expect((await api().get('/api/v1/orders').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    await cashier.as(api().delete(`/api/v1/display/pairings/${p.body.data.pairingId}`));
    expect((await api().get('/api/v1/display/screen').set('Authorization', `Display ${token}`)).status).toBe(401);
  });
});
