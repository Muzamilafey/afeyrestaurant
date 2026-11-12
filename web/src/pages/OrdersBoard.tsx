import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Pencil, Search, Plus, CloudOff, ChevronDown, ChevronRight, Banknote, ClipboardList, Wallet } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime, money, time, toCents, uuid } from '@/lib/format';
import { Button, Empty, Field, Input, Modal, PageHeader, Pill, Select, Skeleton, StatusPill, Stat, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import { localOrders as readLocalOrders, markLocalOrderPaid, type LocalOfflineOrder } from '@/lib/offline';
import type { Order } from './pos/types';

type OrdersView = 'current' | 'held' | 'paid' | 'device' | 'sales';
type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
interface SalesPageResponse { orders: Order[]; total: number; page: number; limit: number; pages: number; summary: { orders: number; totalValue: number; paid: number; balance: number; cash: number; mpesa: number } }
interface SalesRow { id: string; number: string; createdAt: string; location: string; waiter: string; amount: number; status: string; device: boolean; items: Array<{ lineId: string; qty: number; name: string; detail?: string; amount: number; voided: boolean }> }

function dateInputValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Board of open orders — one card per table/ticket with items, subtotal and quick actions. */
export default function OrdersBoard({ initialView = 'current' }: { initialView?: OrdersView }) {
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, branch, session } = useAuth();
  const { confirm, withApproval, handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [view, setView] = useState<OrdersView>(() => {
    const requested = searchParams.get('view');
    return requested && ['current', 'held', 'paid', 'device', 'sales'].includes(requested) ? requested as OrdersView : initialView;
  });
  const [q, setQ] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [salesPage, setSalesPage] = useState(1);
  const [salesTodayKey, setSalesTodayKey] = useState(() => dateInputValue(new Date()));
  const [deviceOrders, setDeviceOrders] = useState<LocalOfflineOrder[]>([]);
  const [payingLocal, setPayingLocal] = useState<LocalOfflineOrder | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'mpesa' | 'split'>('cash');
  const [splitCash, setSplitCash] = useState('');
  const [splitMpesa, setSplitMpesa] = useState('');
  const [payingOrder, setPayingOrder] = useState<Order | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  useEffect(() => {
    const routeView = location.pathname === '/sales' ? 'sales' : new URLSearchParams(location.search).get('view');
    const next = routeView && ['current', 'held', 'paid', 'device', 'sales'].includes(routeView) ? routeView as OrdersView : initialView;
    setView(next);
  }, [location.pathname, location.search, initialView]);
  useEffect(() => {
    const timer = window.setInterval(() => setSalesTodayKey(dateInputValue(new Date())), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!branch?.id) { setDeviceOrders([]); return; }
    const refresh = () => readLocalOrders(branch.id).then(setDeviceOrders).catch(() => setDeviceOrders([]));
    refresh();
    window.addEventListener('chili:local-orders', refresh);
    return () => window.removeEventListener('chili:local-orders', refresh);
  }, [branch?.id]);
  const salesRange = useMemo(() => {
    const start = new Date(`${salesTodayKey}T00:00:00`);
    const endToday = new Date(start);
    endToday.setDate(endToday.getDate() + 1);
    endToday.setMilliseconds(-1);
    if (datePreset === 'yesterday') {
      const yesterday = new Date(start);
      yesterday.setDate(yesterday.getDate() - 1);
      return { from: yesterday, to: new Date(start.getTime() - 1) };
    }
    if (datePreset === '7d' || datePreset === '30d') {
      const from = new Date(start);
      from.setDate(from.getDate() - (datePreset === '7d' ? 6 : 29));
      return { from, to: endToday };
    }
    if (datePreset === 'custom') {
      const from = new Date(`${dateFrom || salesTodayKey}T00:00:00`);
      const to = new Date(`${dateTo || dateFrom || salesTodayKey}T00:00:00`);
      to.setDate(to.getDate() + 1);
      to.setMilliseconds(-1);
      return { from, to };
    }
    return { from: start, to: endToday };
  }, [datePreset, dateFrom, dateTo, salesTodayKey]);
  useEffect(() => setSalesPage(1), [datePreset, dateFrom, dateTo, q, salesTodayKey]);
  const query = view === 'current' ? { status: 'open' }
    : view === 'held' ? { status: 'held' }
      : view === 'paid' ? { status: 'paid', from: new Date(new Date().setHours(0, 0, 0, 0)).toISOString() }
        : view === 'sales' ? {}
          : {};
  const ordersQuery = useQuery<Order[]>({ queryKey: ['orders', 'board', view, query], queryFn: () => get('/orders', query), enabled: view !== 'device' && view !== 'sales', refetchInterval: 20_000 });
  const salesQuery = useQuery<SalesPageResponse>({
    queryKey: ['orders', 'sales', branch?.id, salesRange.from.toISOString(), salesRange.to.toISOString(), salesPage, q],
    queryFn: () => get('/orders/sales', { from: salesRange.from.toISOString(), to: salesRange.to.toISOString(), page: salesPage, limit: 50, q: q || undefined }),
    enabled: view === 'sales', refetchInterval: 20_000,
  });
  const data = ordersQuery.data;
  const isLoading = view === 'sales' ? salesQuery.isLoading : ordersQuery.isLoading;
  const orders = useMemo(() => view === 'sales' ? salesQuery.data?.orders ?? [] : (data ?? []).filter((o) => !q || `${o.number} ${o.tableNumber ?? ''} ${o.customerName ?? ''} ${o.waiterName ?? ''}`.toLowerCase().includes(q.toLowerCase())), [view, salesQuery.data?.orders, data, q]);
  const todayKey = salesTodayKey;
  const visibleDeviceOrders = useMemo(() => deviceOrders.filter((o) => {
    const paid = o.paymentStatus === 'paid';
    if (view === 'current' && paid) return false;
    if (view === 'held') return false;
    if (view === 'paid' && (!paid || !o.paidAt || dateInputValue(new Date(o.paidAt)) !== todayKey)) return false;
    if (view === 'sales' && (new Date(o.createdAt).getTime() < salesRange.from.getTime() || new Date(o.createdAt).getTime() > salesRange.to.getTime())) return false;
    return !q || `${o.number} ${o.tableNumber ?? ''} ${o.customerName ?? ''} ${o.paidBy ?? ''}`.toLowerCase().includes(q.toLowerCase());
  }), [deviceOrders, view, q, todayKey, salesRange]);
  const salesRows = useMemo<SalesRow[]>(() => {
    const serverRows = (salesQuery.data?.orders ?? []).map((o): SalesRow => ({
      id: o._id,
      number: o.number,
      createdAt: (o as Order & { createdAt?: string }).createdAt ?? '',
      location: o.tableNumber ? `Table ${o.tableNumber}` : o.type.replace(/_/g, ' '),
      waiter: o.waiterName ?? '—',
      amount: o.totals.total,
      status: o.status,
      device: false,
      items: o.items.map((item) => ({ lineId: item.lineId, qty: item.qty, name: item.name, detail: [...item.modifiers.map((m) => m.name), item.notes].filter(Boolean).join(' · '), amount: item.lineTotal, voided: item.voided })),
    }));
    const localRows = (view === 'sales' && salesPage === 1 ? visibleDeviceOrders : []).map((o): SalesRow => ({
      id: `device:${o.id}`,
      number: o.number,
      createdAt: o.createdAt,
      location: o.tableNumber ? `Table ${o.tableNumber}` : o.type.replace(/_/g, ' '),
      waiter: o.createdBy ?? 'Device order',
      amount: o.total,
      status: o.paymentStatus ?? 'unpaid',
      device: true,
      items: o.items.map((item) => ({ lineId: item.lineId, qty: item.qty, name: item.name, detail: [item.variant, ...item.modifiers, item.notes].filter(Boolean).join(' · '), amount: item.qty * item.unitPrice, voided: false })),
    }));
    return [...serverRows, ...localRows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [salesQuery.data?.orders, view, salesPage, visibleDeviceOrders]);
  const salesTotal = (salesQuery.data?.total ?? 0) + (view === 'sales' ? visibleDeviceOrders.length : 0);
  const localSalesSummary = visibleDeviceOrders.reduce((summary, order) => ({
    totalValue: summary.totalValue + order.total,
    paid: summary.paid + (order.paymentStatus === 'paid' ? order.total : 0),
    balance: summary.balance + (order.paymentStatus === 'paid' ? 0 : order.total),
    cash: summary.cash + (order.paymentStatus === 'paid' ? order.paymentBreakdown?.cash ?? (order.paymentMethod === 'cash' ? order.total : 0) : 0),
    mpesa: summary.mpesa + (order.paymentStatus === 'paid' ? order.paymentBreakdown?.mpesa ?? (order.paymentMethod === 'mpesa' ? order.total : 0) : 0),
  }), { totalValue: 0, paid: 0, balance: 0, cash: 0, mpesa: 0 });
  const salesSummary = {
    orders: (salesQuery.data?.summary.orders ?? 0) + (view === 'sales' ? visibleDeviceOrders.length : 0),
    totalValue: (salesQuery.data?.summary.totalValue ?? 0) + localSalesSummary.totalValue,
    paid: (salesQuery.data?.summary.paid ?? 0) + localSalesSummary.paid,
    balance: (salesQuery.data?.summary.balance ?? 0) + localSalesSummary.balance,
    cash: (salesQuery.data?.summary.cash ?? 0) + localSalesSummary.cash,
    mpesa: (salesQuery.data?.summary.mpesa ?? 0) + localSalesSummary.mpesa,
  };
  const splitCashCents = Number.isFinite(Number(splitCash)) ? toCents(splitCash || '0') : 0;
  const splitMpesaCents = Number.isFinite(Number(splitMpesa)) ? toCents(splitMpesa || '0') : 0;
  const paymentBalance = payingOrder ? payingOrder.totals.total - payingOrder.totals.paid : payingLocal?.total ?? 0;
  const splitAmountsValid = splitCashCents > 0 && splitMpesaCents > 0 && splitCashCents + splitMpesaCents === paymentBalance;
  const changeView = (next: OrdersView) => {
    setView(next);
    if (next === 'sales') {
      nav('/sales');
      return;
    }
    if (location.pathname === '/sales') {
      nav(next === 'current' ? '/orders' : `/orders?view=${next}`);
      return;
    }
    setSearchParams(next === 'current' ? {} : { view: next }, { replace: true });
  };
  const openLocalPayment = (order: LocalOfflineOrder) => { setPaymentMethod('cash'); setSplitCash(''); setSplitMpesa(''); setPayingLocal(order); };
  const openOrderPayment = (order: Order) => { setPaymentMethod('cash'); setSplitCash(''); setSplitMpesa(''); setPayingOrder(order); };

  async function confirmLocalPaid() {
    if (!payingLocal) return;
    if (paymentMethod === 'split' && !splitAmountsValid) return;
    try {
      await markLocalOrderPaid(payingLocal.id, paymentMethod === 'split' ? 'split' : paymentMethod, session?.user.name ?? 'Cashier', paymentMethod === 'split' ? { cash: splitCashCents, mpesa: splitMpesaCents } : undefined);
      setPayingLocal(null);
      toast('Device order marked as paid');
    } catch (e) {
      handleError(e);
    }
  }

  async function confirmOrderPaid() {
    if (!payingOrder || savingPayment) return;
    if (paymentMethod === 'split' && !splitAmountsValid) return;
    setSavingPayment(true);
    try {
      const balance = payingOrder.totals.total - payingOrder.totals.paid;
      if (paymentMethod === 'split') {
        await post(`/orders/${payingOrder._id}/payments/split`, { cashAmount: splitCashCents, mpesaAmount: splitMpesaCents, idempotencyKey: uuid() });
      } else {
        await post(`/orders/${payingOrder._id}/payments`, {
          method: paymentMethod === 'mpesa' ? 'mpesa_manual' : 'cash',
          amount: balance,
          idempotencyKey: uuid(),
          ...(paymentMethod === 'mpesa' ? { reason: 'M-Pesa payment confirmed at the till' } : {}),
        });
      }
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
      <PageHeader title={view === 'sales' ? 'Sales' : 'Orders'} subtitle={view === 'sales' ? `${salesTotal} orders in the selected dates` : `${orders.length + visibleDeviceOrders.length} ${view === 'paid' ? 'paid today' : view === 'held' ? 'held' : view === 'device' ? 'on-device' : 'open'}`} actions={
        <>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input className="w-52 pl-9" placeholder="Search orders" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select value={view} onChange={(e) => changeView(e.target.value as OrdersView)} className="w-40"><option value="current">Current</option><option value="held">Held</option><option value="paid">Paid today</option><option value="sales">Sales</option><option value="device">Device orders</option></Select>
          {can('orders.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav('/pos')}>New order</Button>}
        </>
      } />
      {view === 'sales' && <>
        <div role="tablist" aria-label="Sales date range" className="mb-3 flex flex-wrap gap-2">
          {([{ id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'custom', label: 'Date filter' }] as const).map((tab) => (
            <button key={tab.id} role="tab" aria-selected={datePreset === tab.id} onClick={() => setDatePreset(tab.id)} className={cx('rounded-xl border px-4 py-2 text-sm font-semibold', datePreset === tab.id ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line bg-card text-ink-soft hover:text-ink')}>{tab.label}</button>
          ))}
          {datePreset === 'custom' && <div className="flex flex-wrap items-center gap-2"><Input aria-label="From date" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /><span className="text-sm text-ink-soft">to</span><Input aria-label="To date" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></div>}
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <Stat label="Orders" value={salesQuery.isLoading ? '—' : salesSummary.orders} icon={<ClipboardList className="h-5 w-5" />} />
          <Stat label="Total value" value={salesQuery.isLoading ? '—' : money(salesSummary.totalValue)} icon={<Banknote className="h-5 w-5" />} tone="green" />
          <Stat label="Total collected" value={salesQuery.isLoading ? '—' : money(salesSummary.paid)} icon={<Banknote className="h-5 w-5" />} />
          <Stat label="Cash collected" value={salesQuery.isLoading ? '—' : money(salesSummary.cash)} icon={<Banknote className="h-5 w-5" />} />
          <Stat label="M-Pesa collected" value={salesQuery.isLoading ? '—' : money(salesSummary.mpesa)} icon={<Wallet className="h-5 w-5" />} />
          <Stat label="Balance due" value={salesQuery.isLoading ? '—' : money(salesSummary.balance)} icon={<Wallet className="h-5 w-5" />} tone={salesSummary.balance > 0 ? 'yellow' : 'default'} />
        </div>
        <SalesOrdersList rows={salesRows} isLoading={salesQuery.isLoading} page={salesPage} pages={Math.max(1, salesQuery.data?.pages ?? 1)} total={salesTotal} onPageChange={setSalesPage} />
      </>}
      {view !== 'sales' && (isLoading && orders.length === 0 && visibleDeviceOrders.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : orders.length === 0 && visibleDeviceOrders.length === 0 ? (
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
                    {can('payments.receive') && balance > 0 && ['open', 'held'].includes(o.status) && <Button className="flex-1" onClick={() => openOrderPayment(o)}>Mark as paid</Button>}
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
                    <p className="text-xs text-ink-soft">{o.number} · {new Date(o.createdAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}{o.createdBy ? ` · ${o.createdBy}` : ''}{o.customerName ? ` · ${o.customerName}` : ''}</p>
                  </div>
                  <StatusPill status={paid ? 'paid' : 'unpaid'} />
                </header>
                <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
                  {o.items.map((item) => <div key={item.lineId} className="flex justify-between gap-3"><span>{item.qty} × {item.name}{item.variant ? ` · ${item.variant}` : ''}{item.modifiers.length ? <span className="block text-xs text-ink-soft">{item.modifiers.join(', ')}</span> : null}</span><span className="shrink-0 tabular-nums">{money(item.qty * item.unitPrice)}</span></div>)}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-xs text-ink-soft">{paid ? `Paid${o.paymentMethod ? ` · ${o.paymentMethod === 'split' ? 'M-Pesa + Cash' : o.paymentMethod}` : ''}${o.paidBy ? ` by ${o.paidBy}` : ''}` : 'Unpaid'}</span>
                  <span className="font-bold">{money(o.total)} <span className="text-[10px] font-normal text-ink-soft">est.</span></span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[11px] text-warn-ink"><CloudOff className="h-3.5 w-3.5" /> This device only</span>
                  {!paid && can('payments.receive') && <Button size="sm" onClick={() => openLocalPayment(o)}>Mark as paid</Button>}
                </div>
              </article>
            );
          })}
        </div>
      ))}
      {payingLocal && <Modal open onClose={() => setPayingLocal(null)} title="Mark device order as paid" footer={<><Button variant="secondary" onClick={() => setPayingLocal(null)}>Cancel</Button><Button disabled={paymentMethod === 'split' && !splitAmountsValid} onClick={confirmLocalPaid}>Mark as paid</Button></>}>
        <p className="mb-3 text-sm">{payingLocal.number} · {money(payingLocal.total)} estimated. This payment record stays on this device.</p>
        <label className="label" htmlFor="local-payment-method">Payment method</label>
        <Select id="local-payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="split">M-Pesa + Cash</option></Select>
        {paymentMethod === 'split' && <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="M-Pesa amount (KSh)"><Input inputMode="decimal" type="number" min="0" step="0.01" value={splitMpesa} onChange={(e) => setSplitMpesa(e.target.value)} /></Field><Field label="Cash amount (KSh)"><Input inputMode="decimal" type="number" min="0" step="0.01" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></Field></div>
          <p className={cx('text-xs', splitAmountsValid ? 'text-brand-dark' : 'text-ink-soft')}>Entered: {money(splitCashCents + splitMpesaCents)} · Due: {money(paymentBalance)}{splitCashCents + splitMpesaCents !== paymentBalance ? ' · amounts must equal the due amount' : ''}</p>
        </div>}
      </Modal>}
      {payingOrder && <Modal open onClose={() => !savingPayment && setPayingOrder(null)} title="Mark order as paid" dismissible={!savingPayment} footer={<><Button variant="secondary" disabled={savingPayment} onClick={() => setPayingOrder(null)}>Cancel</Button><Button disabled={paymentMethod === 'split' && !splitAmountsValid} loading={savingPayment} onClick={confirmOrderPaid}>Mark as paid</Button></>}>
        <p className="mb-3 text-sm">{payingOrder.number} due: {money(payingOrder.totals.total - payingOrder.totals.paid)}</p>
        <label className="label" htmlFor="order-payment-method">Payment method</label>
        <Select id="order-payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="split">M-Pesa + Cash</option></Select>
        {paymentMethod === 'split' && <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="M-Pesa amount (KSh)"><Input inputMode="decimal" type="number" min="0" step="0.01" value={splitMpesa} onChange={(e) => setSplitMpesa(e.target.value)} /></Field><Field label="Cash amount (KSh)"><Input inputMode="decimal" type="number" min="0" step="0.01" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></Field></div>
          <p className={cx('text-xs', splitAmountsValid ? 'text-brand-dark' : 'text-ink-soft')}>Entered: {money(splitCashCents + splitMpesaCents)} · Due: {money(paymentBalance)}{splitCashCents + splitMpesaCents !== paymentBalance ? ' · amounts must equal the due amount' : ''}</p>
        </div>}
      </Modal>}
    </div>
  );
}

function SalesOrdersList({ rows, isLoading, page, pages, total, onPageChange }: { rows: SalesRow[]; isLoading: boolean; page: number; pages: number; total: number; onPageChange: (page: number) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => setExpanded(null), [page]);

  if (isLoading && rows.length === 0) return <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (!rows.length) return <Empty title="No sales for these dates" hint="Choose a different date range to see orders." />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-page text-xs uppercase tracking-wide text-ink-soft"><tr><th className="px-4 py-3">Order number</th><th className="px-4 py-3">Date & time</th><th className="px-4 py-3">Table / type</th><th className="px-4 py-3">Waiter</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const open = expanded === row.id;
              return (
                <Fragment key={row.id}>
                  <tr className="cursor-pointer hover:bg-page/70" onClick={() => setExpanded(open ? null : row.id)}>
                    <td className="px-4 py-3 font-semibold"><span className="inline-flex items-center gap-2">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{row.number}{row.device && <Pill color="yellow">Device</Pill>}</span></td>
                    <td className="px-4 py-3 text-ink-soft">{dateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">{row.location}</td>
                    <td className="px-4 py-3">{row.waiter}</td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">{money(row.amount)}{row.device && <small className="ml-1 font-normal text-ink-soft">est.</small>}</td>
                    <td className="px-4 py-3"><StatusPill status={row.status} /></td>
                  </tr>
                  {open && <tr key={`${row.id}:items`}><td colSpan={6} className="bg-page/60 px-6 py-4">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-soft">Products on this order</p>
                    {row.items.length ? <div className="space-y-2">{row.items.map((item) => <div key={item.lineId} className="flex items-start justify-between gap-4 text-sm">
                      <div className={cx('min-w-0', item.voided && 'text-ink-soft line-through')}><span className="mr-2 inline-block min-w-8 rounded bg-card px-1.5 text-center font-semibold">{item.qty}</span>{item.name}{item.detail && <span className="ml-2 text-xs text-ink-soft">{item.detail}</span>}{item.voided && <Pill color="red" className="ml-2">Voided</Pill>}</div>
                      <span className="shrink-0 font-medium tabular-nums">{money(item.amount)}</span>
                    </div>)}</div> : <p className="text-sm text-ink-soft">No products on this order.</p>}
                  </td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="text-sm text-ink-soft">{total} orders</span>
        <div className="flex items-center gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</Button><span className="text-sm text-ink-soft">Page {page} of {pages}</span><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>Next</Button></div>
      </footer>
    </div>
  );
}
