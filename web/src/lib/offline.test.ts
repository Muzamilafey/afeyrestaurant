import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueOfflineOrder, outbox, syncOutbox, cacheCatalog, cachedCatalog } from './offline';

const order = (clientId: string) => ({
  clientId, terminalId: 'T-1', createdAt: new Date().toISOString(), type: 'takeaway' as const,
  items: [{ lineId: crypto.randomUUID(), productId: 'a'.repeat(24), qty: 1, unitPrice: 15000, name: 'Coke' }],
  payments: [{ clientPaymentId: crypto.randomUUID(), method: 'cash' as const, amount: 15000, tendered: 20000 }],
});

describe('offline outbox', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('caches the catalogue per branch', async () => {
    await cacheCatalog('b1', { products: [1, 2] });
    expect((await cachedCatalog<{ products: number[] }>('b1'))?.data.products).toEqual([1, 2]);
    expect(await cachedCatalog('other')).toBeNull();
  });

  it('marks orders synced exactly once, even when the server reports a duplicate on retry', async () => {
    const id = crypto.randomUUID();
    await queueOfflineOrder('b1', order(id));
    expect((await outbox('pending')).map((o) => o.clientId)).toContain(id);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      // The client strips display-only fields before sending.
      expect(body.orders[0].items[0].name).toBeUndefined();
      return new Response(JSON.stringify({ data: { results: body.orders.map((o: { clientId: string }) => ({ clientId: o.clientId, status: 'duplicate', number: 'ORD-1' })) } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await syncOutbox('b1');
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect((await outbox('pending')).find((o) => o.clientId === id)).toBeUndefined();
    const again = await syncOutbox('b1');
    expect(again.synced).toBe(0); // nothing is re-sent once synced
    vi.unstubAllGlobals();
  });

  it('keeps rejected sales visible for follow-up', async () => {
    const id = crypto.randomUUID();
    await queueOfflineOrder('b2', order(id));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { results: [{ clientId: id, status: 'rejected', error: 'Unknown product' }] } }), { status: 200 })));
    await syncOutbox('b2');
    const rec = (await outbox('rejected')).find((o) => o.clientId === id);
    expect(rec?.error).toBe('Unknown product');
    vi.unstubAllGlobals();
  });
});
