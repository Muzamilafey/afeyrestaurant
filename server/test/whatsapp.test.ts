import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setupDb, teardownDb, uuid, type Session } from './helpers';
import { Branch, NotificationJob, Product } from '../src/models';
import { MetaWhatsAppProvider, MockWhatsAppProvider } from '../src/integrations/whatsapp/provider';
import { notify, processNotificationQueue } from '../src/services/notify';

let seed: Awaited<ReturnType<typeof setupDb>>;
let owner: Session;
let cashier: Session;

describe('WhatsApp', () => {
  beforeAll(async () => {
    seed = await setupDb();
    await Branch.updateMany({ tenantId: seed.tenantId }, { $set: { 'settings.happyHours': [] } });
    [owner, cashier] = await Promise.all([login('owner@chili.demo'), login('cashier@chili.demo')]);
  });
  afterAll(teardownDb);

  it('sends Meta Cloud API template messages with flattened variables (or free text)', async () => {
    const real = globalThis.fetch;
    let sent: any = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => { sent = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.X1' }] }), { status: 200 }); }) as typeof fetch;
    try {
      const p = new MetaWhatsAppProvider({ accessToken: 'tok', phoneNumberId: '1234567890', mode: 'template', templateName: 'chili_message', templateLanguage: 'en', businessName: 'Afey Resort' });
      const r = await p.send('254712345678', 'Receipt R-1\n\nTotal   KSh 240.00\nThank you!');
      expect(r).toMatchObject({ ok: true, messageId: 'wamid.X1', simulated: false });
      expect(sent.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
      expect(sent.auth).toBe('Bearer tok');
      expect(sent.body).toMatchObject({ messaging_product: 'whatsapp', to: '254712345678', type: 'template', template: { name: 'chili_message', language: { code: 'en' } } });
      const params = sent.body.template.components[0].parameters.map((x: { text: string }) => x.text);
      expect(params[0]).toBe('Afey Resort');
      expect(params[1]).not.toMatch(/\n|\t| {4,}/);
      const t = new MetaWhatsAppProvider({ accessToken: 'tok', phoneNumberId: '1', mode: 'text', businessName: 'X' });
      await t.send('254712345678', 'line 1\nline 2');
      expect(sent.body).toMatchObject({ type: 'text', text: { body: 'line 1\nline 2' } });
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 })) as typeof fetch;
      await expect(t.send('254712345678', 'hi')).rejects.toThrow(/131047/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('sends a receipt by WhatsApp, and customer SMS go by WhatsApp when set to', async () => {
    const save = await owner.as(api().put('/api/v1/integrations/whatsapp').send({ provider: 'mock', enabled: true, environment: 'mock', settings: { useFor: 'instead_of_sms' }, secrets: {} }));
    expect(save.status).toBe(200);
    await owner.as(api().put('/api/v1/integrations/sms').send({ provider: 'mock', enabled: true, environment: 'mock', settings: {}, secrets: {} }));
    const coke = String((await Product.findOne({ tenantId: seed.tenantId, sku: 'SD-001' }).lean())!._id);
    await cashier.as(api().post('/api/v1/cash/session/open').send({ openingFloat: 0 }));
    const o = (await cashier.as(api().post('/api/v1/orders').send({ clientId: uuid(), type: 'takeaway', items: [{ productId: coke, qty: 1 }] }))).body.data;
    await cashier.as(api().post(`/api/v1/orders/${o._id}/payments`).send({ method: 'cash', amount: o.totals.total, idempotencyKey: uuid() }));
    MockWhatsAppProvider.sent.length = 0;
    const r = await cashier.as(api().post(`/api/v1/orders/${o._id}/receipt/send`).send({ channel: 'whatsapp', to: '0712345678' }));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ channel: 'whatsapp', to: '254712345678', status: 'queued' });

    // A customer SMS (order ready) goes by WhatsApp instead; a manager summary stays an SMS.
    await notify(seed.tenantId, { event: 'order_ready', channel: 'sms', to: '0722000111', vars: { customer_name: 'Jane', order_number: 'ORD-1' }, dedupeKey: `t:${uuid()}` });
    await notify(seed.tenantId, { event: 'manager_sales_summary', channel: 'sms', to: '0733000222', vars: { branch_name: 'Main', date: 'x', total_sales: '1', order_count: 1 }, dedupeKey: `t:${uuid()}` });
    await processNotificationQueue(20);
    expect(MockWhatsAppProvider.sent.map((m) => m.to).sort()).toEqual(['254712345678', '254722000111']);
    expect(MockWhatsAppProvider.sent.find((m) => m.to === '254712345678')!.text).toContain(o.number);
    expect(await NotificationJob.exists({ tenantId: seed.tenantId, channel: 'sms', to: '254722000111' })).toBeNull();
    expect(await NotificationJob.exists({ tenantId: seed.tenantId, channel: 'sms', to: '254733000222' })).toBeTruthy();
  });
});
