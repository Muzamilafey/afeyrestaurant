import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Pencil, Search, Plus, CloudOff } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime, money, time, uuid } from '@/lib/format';
import { Button, Empty, Input, Modal, PageHeader, Select, Skeleton, StatusPill, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import { localOrders as readLocalOrders, markLocalOrderPaid, type LocalOfflineOrder } from '@/lib/offline';
import type { Order } from './pos/types';

type OrdersView = 'current' | 'held' | 'paid' | 'device' | 'sales';
type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

function dateInputValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Board of open orders — one card per table/ticket with items, subtotal and quick actions. */
export default function OrdersBoard() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, branch, session } = useAuth();
  const { confirm, withApproval, handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [view, setView] = useState<OrdersView>(() => searchParams.get('view') === 'device' ? 'device' : searchParams.get('view') === 'sales' ? 'sales' : 'current');
  const [q, setQ] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deviceOrders, setDeviceOrders] = useState<LocalOfflineOrder[]>([]);
  const [payingLocal, setPayingLocal] = useState<LocalOfflineOrder | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'mpesa'>('cash');
  const [payingOrder, setPayingOrder] = useState<Order | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  useEffect(() => {
    if (!branch?.id) { setDeviceOrders([]); return; }
    const refresh = () => readLocalOrders(branch.id).then(setDeviceOrders).catch(() => setDeviceOrders([]));
    refresh();
    window.addEventListener('chili:local-orders', refresh);
    return () => window.removeEventListener('chili:local-orders', refresh);
  }, [branch?.id]);
  const salesRange = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (datePreset === 'yesterday') return { from: new Date(start.getTime() - 86_400_000), to: new Date(start.getTime() - 1) };
    if (datePreset === '7d') return { from: new Date(start.getTime() - 6 * 86_400_000), to: now };
    if (datePreset === '30d') return { from: new Date(start.getTime() - 29 * 86_400_000), to: now };
    if (datePreset === 'custom') {
      const today = dateInputValue(now);
      return { from: new Date(`${dateFrom || today}T00:00:00`), to: new Date(`${dateTo || dateFrom || today}T23:59:59.999`) };
    }
    return { from: start, to: now };
  }, [datePreset, dateFrom, dateTo]);
  const query = view === 'current' ? { status: 'open' }
    : view === 'held' ? { status: 'held' }
      : view === 'paid' ? { status: 'paid', from: new Date(new Date().setHours(0, 0, 0, 0)).toISOString() }
        : view === 'sales' ? { from: salesRange.from.toISOString(), to: salesRange.to.toISOString(), limit: 200 }
          : {};
  const { data, isLoading } = useQuery<Order[]>({ queryKey: ['orders', 'board', view, query], queryFn: () => get('/orders', query), enabled: view !== 'device', refetchInterval: 20_000 });
  const orders = useMemo(() => (data ?? []).filter((o) => !q || `${o.number} ${o.tableNumber ?? ''} ${o.customerName ?? ''} ${o.waiterName ?? ''}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const todayKey = dateInputValue(new Date());
  const visibleDeviceOrders = useMemo(() => deviceOrders.filter((o) => {
    const paid = o.paymentStatus === 'paid';
    if (view === 'current' && paid) return false;
    if (view === 'held') return false;
    if (view === 'paid' && (!paid || !o.paidAt || dateInputValue(new Date(o.paidAt)) !== todayKey)) return false;
    if (view === 'sales' && (new Date(o.createdAt).getTime() < salesRange.from.getTime() || new Date(o.createdAt).getTime() > salesRange.to.getTime())) return false;
    return !q || `${o.number} ${o.tableNumber ?? ''} ${o.customerName ?? ''} ${o.paidBy ?? ''}`.toLowerCase().includes(q.toLowerCase());
  }), [deviceOrders, view, q, todayKey, salesRange]);
  const changeView = (next: OrdersView) => {
    setView(next);
    setSearchParams(next === 'current' ? {} : { view: next }, { replace: true });
  };

  async function confirmLocalPaid() {
    if (!payingLocal) return;
    try {
      await markLocalOrderPaid(payingLocal.id, paymentMethod, session?.user.name ?? 'Cashier');
      setPayingLocal(null);
      toast('Device order marked as paid');
    } catch (e) {
      handleError(e);
    }
  }

  async function confirmOrderPaid() {
    if (!payingOrder || savingPayment) return;
    setSavingPayment(true);
    try {
      const balance = payingOrder.totals.total - payingOrder.totals.paid;
      await post(`/orders/${payingOrder._id}/payments`, {
        method: paymentMethod === 'mpesa' ? 'mpesa_manual' : 'cash',
        amount: balance,
        idempotencyKey: uuid(),
        ...(paymentMethod === 'mpesa' ? { reason: 'M-Pesa payment confirmed at the till' } : {}),
      });
      setPayingOrder(null);
      await qc.invalidateQueries({ queryKey: ['orders'] });
      toast('Order marked as paid');
    } catch (e) {
      handleError(e);
    } finally {
      setSavingPayment(false);
    }
  }

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
      <PageHeader title="Orders" subtitle={`${orders.length + visibleDeviceOrders.length} ${view === 'paid' ? 'paid today' : view === 'held' ? 'held' : view === 'device' ? 'on-device' : view === 'sales' ? 'in selected dates' : 'open'}`} actions={
        <>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input className="w-52 pl-9" placeholder="Search orders" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select value={view} onChange={(e) => changeView(e.target.value as OrdersView)} className="w-40"><option value="current">Current</option><option value="held">Held</option><option value="paid">Paid today</option><option value="sales">Orders by date</option><option value="device">Device orders</option></Select>
          {view === 'sales' && <>
            <Select aria-label="Order date range" value={datePreset} onChange={(e) => setDatePreset(e.target.value as DatePreset)} className="w-36"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="custom">Date filter</option></Select>
            {datePreset === 'custom' && <><Input aria-label="From date" type="date" className="w-40" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /><Input aria-label="To date" type="date" className="w-40" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></>}
          </>}
          {can('orders.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav('/pos')}>New order</Button>}
        </>
      } />
      {isLoading && orders.length === 0 && visibleDeviceOrders.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : orders.length === 0 && visibleDeviceOrders.length === 0 ? (
        <Empty title="No orders here" hint={view === 'current' ? 'New orders from the POS appear here instantly.' : view === 'sales' ? 'No orders were placed in this date range.' : undefined} />
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
                    <p className="text-xs text-ink-soft">{o.waiterName}{o.customerName ? ` · ${o.customerName}` : ''} · {view === 'sales' ? dateTime((o as Order & { createdAt?: string }).createdAt) : time((o as Order & { createdAt?: string }).createdAt)}</p>
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
                    {can('payments.receive') && balance > 0 && ['open', 'held'].includes(o.status) && <Button className="flex-1" onClick={() => { setPaymentMethod('cash'); setPayingOrder(o); }}>Mark as paid</Button>}
                  </div>
                )}
              </article>
            );
          })}
          {visibleDeviceOrders.map((o) => {
            const paid = o.paymentStatus === 'paid';
            return (
              <article key={o.id} className="card mb-4 break-inside-avoid border border-dashed border-warn/60 p-4">
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold">{o.tableNumber ? `Table ${o.tableNumber}` : o.type === 'delivery' ? 'Delivery' : o.type === 'bar_counter' ? 'Bar' : 'Takeaway'}</h3>
                    <p className="text-xs text-ink-soft">{o.number} · {view === 'sales' ? dateTime(o.createdAt) : new Date(o.createdAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}{o.createdBy ? ` · ${o.createdBy}` : ''}{o.customerName ? ` · ${o.customerName}` : ''}</p>
                  </div>
                  <StatusPill status={paid ? 'paid' : 'unpaid'} />
                </header>
                <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
                  {o.items.map((item) => <div key={item.lineId} className="flex justify-between gap-3"><span>{item.qty} × {item.name}{item.variant ? ` · ${item.variant}` : ''}{item.modifiers.length ? <span className="block text-xs text-ink-soft">{item.modifiers.join(', ')}</span> : null}</span><span className="shrink-0 tabular-nums">{money(item.qty * item.unitPrice)}</span></div>)}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-xs text-ink-soft">{paid ? `Paid${o.paymentMethod ? ` · ${o.paymentMethod}` : ''}${o.paidBy ? ` by ${o.paidBy}` : ''}` : 'Unpaid'}</span>
                  <span className="font-bold">{money(o.total)} <span className="text-[10px] font-normal text-ink-soft">est.</span></span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[11px] text-warn-ink"><CloudOff className="h-3.5 w-3.5" /> This device only</span>
                  {!paid && can('payments.receive') && <Button size="sm" onClick={() => { setPaymentMethod('cash'); setPayingLocal(o); }}>Mark as paid</Button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {payingLocal && <Modal open onClose={() => setPayingLocal(null)} title="Mark device order as paid" footer={<><Button variant="secondary" onClick={() => setPayingLocal(null)}>Cancel</Button><Button onClick={confirmLocalPaid}>Mark as paid</Button></>}>
                <p className="mb-3 text-sm">{payingLocal.number} · {money(payingLocal.total)} estimated. This payment record stays on this device.</p>
        <label className="label" htmlFor="local-payment-method">Payment method</label>
        <Select id="local-payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option></Select>
      </Modal>}
      {payingOrder && <Modal open onClose={() => !savingPayment && setPayingOrder(null)} title="Mark order as paid" dismissible={!savingPayment} footer={<><Button variant="secondary" disabled={savingPayment} onClick={() => setPayingOrder(null)}>Cancel</Button><Button loading={savingPayment} onClick={confirmOrderPaid}>Mark as paid</Button></>}>
        <p className="mb-3 text-sm">{payingOrder.number} due: {money(payingOrder.totals.total - payingOrder.totals.paid)}</p>
        <label className="label" htmlFor="order-payment-method">Payment method</label>
        <Select id="order-payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option></Select>
      </Modal>}
    </div>
  );
}
