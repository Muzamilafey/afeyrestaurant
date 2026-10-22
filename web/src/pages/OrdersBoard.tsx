import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Pencil, Search, Plus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { money, time } from '@/lib/format';
import { Button, Empty, Input, PageHeader, Select, Skeleton, StatusPill, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import type { Order } from './pos/types';

/** Board of open orders — one card per table/ticket with items, subtotal and quick actions. */
export default function OrdersBoard() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { confirm, withApproval, handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [view, setView] = useState<'current' | 'held' | 'paid'>('current');
  const [q, setQ] = useState('');
  const query = view === 'current' ? { status: 'open' } : view === 'held' ? { status: 'held' } : { status: 'paid', from: new Date(new Date().setHours(0, 0, 0, 0)).toISOString() };
  const { data, isLoading } = useQuery<Order[]>({ queryKey: ['orders', 'board', view], queryFn: () => get('/orders', query), refetchInterval: 20_000 });
  const orders = useMemo(() => (data ?? []).filter((o) => !q || `${o.number} ${o.tableNumber ?? ''} ${o.customerName ?? ''} ${o.waiterName ?? ''}`.toLowerCase().includes(q.toLowerCase())), [data, q]);

  const voidOrder = async (o: Order) => {
    const c = await confirm({ title: `Void ${o.number}?`, message: 'All items and kitchen tickets are cancelled. This is recorded in the audit log.', reason: true, danger: true, confirmLabel: 'Void order' });
    if (!c.ok) return;
    try {
      await withApproval((approval) => post(`/orders/${o._id}/void`, { reason: c.reason, approval }));
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast('Order voided');
    } catch (e) {
      handleError(e);
    }
  };

  return (
    <div>
      <PageHeader title="Orders" subtitle={`${orders.length} ${view === 'paid' ? 'paid today' : view === 'held' ? 'held' : 'open'}`} actions={
        <>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input className="w-52 pl-9" placeholder="Search orders" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select value={view} onChange={(e) => setView(e.target.value as typeof view)} className="w-36"><option value="current">Current</option><option value="held">Held</option><option value="paid">Paid today</option></Select>
          {can('orders.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav('/pos')}>New order</Button>}
        </>
      } />
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : orders.length === 0 ? (
        <Empty title="No orders here" hint={view === 'current' ? 'New orders from the POS appear here instantly.' : undefined} />
      ) : (
        <div className="columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4">
          {orders.map((o) => {
            const lines = o.items.filter((i) => !i.voided);
            const balance = o.totals.total - o.totals.paid;
            return (
              <article key={o._id} className="card mb-4 break-inside-avoid p-4">
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold">{o.tableNumber ? `Table ${o.tableNumber}` : o.type === 'delivery' ? 'Delivery' : o.type === 'bar_counter' ? 'Bar' : 'Takeaway'}</h3>
                    <p className="text-xs text-ink-soft">{o.waiterName}{o.customerName ? ` · ${o.customerName}` : ''} · {time((o as Order & { createdAt?: string }).createdAt)}</p>
                  </div>
                  <div className="text-right"><p className="text-xs text-ink-soft">Order {o.number.split('-').pop()}</p>{view !== 'current' && <StatusPill status={o.status} />}</div>
                </header>
                <table className="mt-3 w-full text-sm">
                  <thead><tr className="text-[11px] uppercase tracking-wide text-ink-soft"><th className="w-8 pb-1 text-left font-medium">Qt</th><th className="pb-1 text-left font-medium">Items</th><th className="pb-1 text-right font-medium">Price</th></tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.lineId} className="align-top">
                        <td className="py-0.5">{l.qty}</td>
                        <td className="py-0.5"><span className={cx(l.status === 'ready' && 'text-brand-dark')}>{l.name}</span>{l.modifiers.length > 0 && <span className="block text-[11px] text-ink-soft">{l.modifiers.map((m) => m.name).join(', ')}</span>}</td>
                        <td className="py-0.5 text-right tabular-nums">{money(l.lineTotal, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-xs text-ink-soft">{o.totals.paid > 0 ? 'Balance' : 'Subtotal'}</span>
                  <span className="text-base font-bold">{money(view === 'paid' ? o.totals.total : balance)}</span>
                </div>
                {view !== 'paid' && (
                  <div className="mt-3 flex gap-2">
                    {can('orders.void') && o.totals.paid === 0 && <button onClick={() => voidOrder(o)} className="grid h-10 w-10 place-items-center rounded-xl border border-line text-ink-soft hover:border-danger hover:text-danger" aria-label="Void order"><Trash2 className="h-4 w-4" /></button>}
                    <button onClick={() => nav(`/pos?order=${o._id}`)} className="grid h-10 w-10 place-items-center rounded-xl border border-line text-ink-soft hover:border-brand hover:text-brand-dark" aria-label="Edit order"><Pencil className="h-4 w-4" /></button>
                    {can('payments.receive') && <Button className="flex-1" onClick={() => nav(`/pos?order=${o._id}&pay=1`)}>Payment</Button>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
