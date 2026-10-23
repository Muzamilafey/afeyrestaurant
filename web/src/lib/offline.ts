import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { post } from './api';

/**
 * Offline support: the POS catalogue is cached per branch in IndexedDB and offline sales are written to an
 * ordered outbox. Each sale carries a client UUID (order) and per-payment UUIDs, so synchronisation is
 * idempotent: re-sending never duplicates a sale. Offline sales are "pending sync" until the server confirms.
 */
interface ChiliDB extends DBSchema {
  catalog: { key: string; value: { branchId: string; savedAt: string; data: unknown } };
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
  tableId?: string;
  customerName?: string;
  notes?: string;
  items: Array<{ lineId: string; productId: string; qty: number; variant?: string; modifiers?: Array<{ groupId: string; optionId: string }>; notes?: string; unitPrice: number; name: string }>;
  payments: Array<{ clientPaymentId: string; method: 'cash' | 'card' | 'mpesa'; amount: number; tendered?: number; reference?: string; phone?: string }>;
}

let dbp: Promise<IDBPDatabase<ChiliDB>> | null = null;
const db = () =>
  (dbp ??= openDB<ChiliDB>('chili-pos', 1, {
    upgrade(d) {
      d.createObjectStore('catalog', { keyPath: 'branchId' });
      const o = d.createObjectStore('outbox', { keyPath: 'clientId' });
      o.createIndex('byStatus', 'status');
    },
  }));

export async function cacheCatalog(branchId: string, data: unknown) {
  await (await db()).put('catalog', { branchId, savedAt: new Date().toISOString(), data });
}
export async function cachedCatalog<T>(branchId: string): Promise<{ savedAt: string; data: T } | null> {
  const r = await (await db()).get('catalog', branchId);
  return r ? { savedAt: r.savedAt, data: r.data as T } : null;
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
