import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { post } from './api';

/**
 * Offline support: the POS catalogue is cached per branch in IndexedDB and offline sales are written to an
 * ordered outbox. Each sale carries a client UUID (order) and per-payment UUIDs, so synchronisation is
 * idempotent: re-sending never duplicates a sale. Offline sales are "pending sync" until the server confirms.
 */
interface ChiliDB extends DBSchema {
  catalog: { key: string; value: { branchId: string; savedAt: string; data: unknown } };
  tables: { key: string; value: { branchId: string; savedAt: string; data: unknown } };
  localOrders: {
    key: string;
    value: LocalOfflineOrder;
    indexes: { byBranch: string; byCreatedAt: string };
  };
  outbox: {
    key: string;
    value: { clientId: string; branchId: string; createdAt: string; status: 'pending' | 'synced' | 'rejected'; error?: string; serverNumber?: string; payload: OfflineOrderPayload };
    indexes: { byStatus: string };
  };
}
export interface OfflineOrderPayload {
  clientId: string;
  terminalId: string;
  createdAt: string;
  type: 'dine_in' | 'takeaway' | 'bar_counter';
  outlet?: 'restaurant' | 'bar';
  tableId?: string;
  customerName?: string;
  notes?: string;
  items: Array<{ lineId: string; productId: string; qty: number; variant?: string; modifiers?: Array<{ groupId: string; optionId: string }>; notes?: string; unitPrice: number; name: string }>;
  payments: Array<{ clientPaymentId: string; method: 'cash' | 'card' | 'mpesa'; amount: number; tendered?: number; reference?: string; phone?: string }>;
}

/** Orders placed without a connection. These stay on this device and are never sent to the server. */
export interface LocalOfflineOrder {
  id: string;
  branchId: string;
  number: string;
  createdAt: string;
  outlet: 'restaurant' | 'bar';
  type: 'dine_in' | 'takeaway' | 'delivery' | 'bar_counter';
  tableId?: string;
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  createdBy?: string;
  deliveryAddress?: string;
  items: Array<{ lineId: string; productId: string; name: string; qty: number; unitPrice: number; variant?: string; modifiers: string[]; notes?: string; station: string }>;
  subtotal: number;
  serviceCharge: number;
  total: number;
  paymentStatus?: 'unpaid' | 'paid';
  paymentMethod?: 'cash' | 'card' | 'mpesa';
  paidAt?: string;
  paidBy?: string;
}

let dbp: Promise<IDBPDatabase<ChiliDB>> | null = null;
const db = () =>
  (dbp ??= openDB<ChiliDB>('chili-pos', 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('catalog', { keyPath: 'branchId' });
        const o = d.createObjectStore('outbox', { keyPath: 'clientId' });
        o.createIndex('byStatus', 'status');
      }
      if (oldVersion < 2) d.createObjectStore('tables', { keyPath: 'branchId' });
      if (oldVersion < 3) {
        const orders = d.createObjectStore('localOrders', { keyPath: 'id' });
        orders.createIndex('byBranch', 'branchId');
        orders.createIndex('byCreatedAt', 'createdAt');
      }
    },
  }));

export async function cacheCatalog(branchId: string, data: unknown) {
  await (await db()).put('catalog', { branchId, savedAt: new Date().toISOString(), data });
}
export async function cachedCatalog<T>(branchId: string): Promise<{ savedAt: string; data: T } | null> {
  const r = await (await db()).get('catalog', branchId);
  return r ? { savedAt: r.savedAt, data: r.data as T } : null;
}
export async function cacheTables(branchId: string, data: unknown) {
  await (await db()).put('tables', { branchId, savedAt: new Date().toISOString(), data });
}
export async function cachedTables<T>(branchId: string): Promise<{ savedAt: string; data: T } | null> {
  const r = await (await db()).get('tables', branchId);
  return r ? { savedAt: r.savedAt, data: r.data as T } : null;
}

export async function saveLocalOrder(order: LocalOfflineOrder) {
  await (await db()).put('localOrders', order);
  window.dispatchEvent(new Event('chili:local-orders'));
}
export async function localOrders(branchId?: string): Promise<LocalOfflineOrder[]> {
  const d = await db();
  const orders = branchId ? await d.getAllFromIndex('localOrders', 'byBranch', branchId) : await d.getAll('localOrders');
  return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function markLocalOrderPaid(id: string, paymentMethod: 'cash' | 'card' | 'mpesa', paidBy: string) {
  const d = await db();
  const order = await d.get('localOrders', id);
  if (!order || order.paymentStatus === 'paid') return order ?? null;
  const paid = { ...order, paymentStatus: 'paid' as const, paymentMethod, paidAt: new Date().toISOString(), paidBy };
  await d.put('localOrders', paid);
  window.dispatchEvent(new Event('chili:local-orders'));
  return paid;
}

export async function queueOfflineOrder(branchId: string, payload: OfflineOrderPayload) {
  await (await db()).put('outbox', { clientId: payload.clientId, branchId, createdAt: payload.createdAt, status: 'pending', payload });
  window.dispatchEvent(new Event('chili:outbox'));
}
export async function outbox(status?: 'pending' | 'synced' | 'rejected') {
  const d = await db();
  const all = status ? await d.getAllFromIndex('outbox', 'byStatus', status) : await d.getAll('outbox');
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function terminalId() {
  let id = localStorage.getItem('chili.terminal');
  if (!id) {
    id = `T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    localStorage.setItem('chili.terminal', id);
  }
  return id;
}

let syncing = false;
/** Push pending offline orders (oldest first). Safe to call repeatedly. */
export async function syncOutbox(branchId: string) {
  if (syncing || !navigator.onLine) return { synced: 0, rejected: 0 };
  syncing = true;
  try {
    const pending = (await outbox('pending')).filter((o) => o.branchId === branchId);
    let synced = 0;
    let rejected = 0;
    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);
      const res = await post<{ results: Array<{ clientId: string; status: string; number?: string; error?: string }> }>('/sync/orders', { orders: batch.map((b) => ({ ...b.payload, items: b.payload.items.map(({ name: _n, ...it }) => it) })) });
      const d = await db();
      for (const r of res.results) {
        const rec = await d.get('outbox', r.clientId);
        if (!rec) continue;
        if (r.status === 'created' || r.status === 'duplicate') {
          rec.status = 'synced';
          rec.serverNumber = r.number;
          synced++;
        } else {
          rec.status = 'rejected';
          rec.error = r.error;
          rejected++;
        }
        await d.put('outbox', rec);
      }
    }
    window.dispatchEvent(new Event('chili:outbox'));
    return { synced, rejected };
  } finally {
    syncing = false;
  }
}
