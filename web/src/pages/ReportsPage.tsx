import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { TrendingUp, Receipt, Wallet, Percent, Download, Package, AlertTriangle } from 'lucide-react';
import { download, get } from '@/lib/api';
import { money, titleCase } from '@/lib/format';
import { Button, Card, DataTable, Input, PageHeader, Pill, Select, Skeleton, Stat, Tabs, ErrorBox } from '@/components/ui';
import { useAuth } from '@/auth/AuthContext';
import { localOrders as readLocalOrders, type LocalOfflineOrder } from '@/lib/offline';
import { EndOfDay } from './EndOfDay';

const PALETTE = ['#07963C', '#2B5FA8', '#F4B942', '#DC4545', '#7A5AF8', '#0EA5A4', '#9CA3AF'];
const k = (c: number) => `${Math.round(c / 100).toLocaleString()}`;

function useRange() {
  const [preset, setPreset] = useState('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const ranges: Record<string, [Date, Date]> = {
    today: [start, now],
    yesterday: [new Date(start.getTime() - 86400_000), start],
    '7d': [new Date(start.getTime() - 6 * 86400_000), now],
    '30d': [new Date(start.getTime() - 29 * 86400_000), now],
    custom: [from ? new Date(`${from}T00:00:00`) : start, to ? new Date(`${to}T23:59:59`) : now],
  };
  const [f, t] = ranges[preset];
  return { preset, setPreset, from, setFrom, to, setTo, query: { from: f.toISOString(), to: t.toISOString() } };
}

export default function ReportsPage() {
  const { can, session } = useAuth();
  const [tab, setTab] = useState<'sales' | 'inventory' | 'kitchen' | 'eod'>(can('reports.sales') ? 'sales' : 'inventory');
  const r = useRange();
  const [branch, setBranch] = useState('');
  const [outlet, setOutlet] = useState('');
  const q = { ...r.query, branchId: branch || undefined, outlet: outlet || undefined };
  return (
    <div>
      <PageHeader title="Reports & analytics" subtitle="Branch reports with device-only offline sales shown separately" actions={
        <>
          <Select value={r.preset} onChange={(e) => r.setPreset(e.target.value)} className="w-36"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="custom">Date filter</option></Select>
          {r.preset === 'custom' && <><Input type="date" className="w-40" value={r.from} onChange={(e) => r.setFrom(e.target.value)} /><Input type="date" className="w-40" value={r.to} onChange={(e) => r.setTo(e.target.value)} /></>}
          <Select value={outlet} onChange={(e) => setOutlet(e.target.value)} className="w-40" aria-label="Outlet"><option value="">Restaurant + bar</option><option value="restaurant">Restaurant POS</option><option value="bar">Bar POS</option></Select>
          {(session?.branches.length ?? 0) > 1 && <Select value={branch} onChange={(e) => setBranch(e.target.value)} className="w-44"><option value="">Active branch</option>{session?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}<option value="all">All branches</option></Select>}
        </>
      } />
      <Tabs tabs={[{ id: 'sales', label: 'Sales', hidden: !can('reports.sales') }, { id: 'inventory', label: 'Inventory & costs', hidden: !can('reports.inventory') }, { id: 'kitchen', label: 'Kitchen & tables', hidden: !can('reports.sales') }, { id: 'eod', label: 'End of day', hidden: !can('reports.sales', 'cash.session_view_all') }]} value={tab} onChange={setTab} />
      {tab === 'sales' && <Sales q={q} />}
      {tab === 'inventory' && <Inventory q={q} />}
      {tab === 'kitchen' && <KitchenTables q={q} />}
      {tab === 'eod' && <EndOfDay branchId={branch || undefined} />}
    </div>
  );
}

interface SalesResp { summary: { revenue: number; orders: number; averageOrderValue: number; discounts: number; serviceCharge: number; tax: number; refunded: number; netSales: number; voids: { count: number; value: number } }; trend: Array<{ _id: string; revenue: number; orders: number }>; hourly: Array<{ _id: number; revenue: number }>; payments: Array<{ _id: string; amount: number; count: number; manual: number }>; topItems: Array<{ name: string; qty: number; revenue: number; category?: string }>; categories: Array<{ category: string; revenue: number; qty: number }>; byCashier: Array<{ _id: string; name?: string; revenue: number; orders: number }>; byWaiter: Array<{ _id: string; name?: string; revenue: number; orders: number }>; byType: Array<{ _id: string; revenue: number; orders: number }>; byOutlet?: Array<{ outlet: string; revenue: number; orders: number }>; tips?: { total: number; byStaff: Array<{ userId: string; name: string; cash: number; mpesa: number; total: number; count: number }> }; refunds: Array<{ _id: string; amount: number; count: number }> }

function dateKeyAt(value: string | Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function Sales({ q }: { q: Record<string, string | undefined> }) {
  const { session } = useAuth();
  const [localOrders, setLocalOrders] = useState<LocalOfflineOrder[]>([]);
  const branchId = q.branchId === 'all' ? undefined : q.branchId ?? session?.activeBranchId ?? undefined;
  useEffect(() => {
    const refresh = () => readLocalOrders(branchId).then(setLocalOrders).catch(() => setLocalOrders([]));
    refresh();
    window.addEventListener('chili:local-orders', refresh);
    return () => window.removeEventListener('chili:local-orders', refresh);
  }, [branchId]);
  const { data, isLoading, error, refetch } = useQuery<SalesResp>({ queryKey: ['report-sales', q], queryFn: () => get('/reports/sales', q) });
  const timezone = session?.business?.settings?.timezone ?? 'Africa/Nairobi';
  const fromKey = q.from ? dateKeyAt(q.from, timezone) : dateKeyAt(new Date(), timezone);
  const toKey = q.to ? dateKeyAt(q.to, timezone) : dateKeyAt(new Date(), timezone);
  const dailyRows = useMemo(() => {
    const rows = new Map<string, { date: string; serverSales: number; serverOrders: number; devicePaid: number; devicePaidOrders: number; deviceUnpaid: number; deviceUnpaidOrders: number }>();
    const rowFor = (date: string) => {
      let row = rows.get(date);
      if (!row) { row = { date, serverSales: 0, serverOrders: 0, devicePaid: 0, devicePaidOrders: 0, deviceUnpaid: 0, deviceUnpaidOrders: 0 }; rows.set(date, row); }
      return row;
    };
    const day = new Date(`${fromKey}T00:00:00.000Z`);
    const lastDay = new Date(`${toKey}T00:00:00.000Z`);
    for (; day <= lastDay; day.setUTCDate(day.getUTCDate() + 1)) rowFor(day.toISOString().slice(0, 10));
    for (const trend of data?.trend ?? []) {
      const date = trend._id.slice(0, 10);
      const row = rowFor(date);
      row.serverSales += trend.revenue;
      row.serverOrders += trend.orders;
    }
    for (const order of localOrders) {
      if (q.outlet && order.outlet !== q.outlet) continue;
      const date = dateKeyAt(order.paymentStatus === 'paid' ? order.paidAt ?? order.createdAt : order.createdAt, timezone);
      if (date < fromKey || date > toKey) continue;
      const row = rowFor(date);
      if (order.paymentStatus === 'paid') { row.devicePaid += order.total; row.devicePaidOrders++; }
      else { row.deviceUnpaid += order.total; row.deviceUnpaidOrders++; }
    }
    return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [data?.trend, localOrders, timezone, fromKey, toKey, q.outlet]);
  const dailySales = <Card title="Daily sales by date"><p className="mb-3 text-xs text-ink-soft">Device-only amounts are local estimates and are not sent to the server.</p><DataTable rows={dailyRows} empty="No sales or device orders in this date range" rowKey={(r) => r.date} columns={[
    { key: 'd', header: 'Date', render: (r) => r.date },
    { key: 's', header: 'Server sales', render: (r) => <span>{money(r.serverSales)} <small>({r.serverOrders})</small></span> },
    { key: 'p', header: 'Device paid (est.)', render: (r) => <span>{money(r.devicePaid)} <small>({r.devicePaidOrders})</small></span> },
    { key: 'u', header: 'Device unpaid (est.)', render: (r) => <span>{money(r.deviceUnpaid)} <small>({r.deviceUnpaidOrders})</small></span> },
    { key: 't', header: 'Total paid', render: (r) => <b>{money(r.serverSales + r.devicePaid)}</b> },
  ]} /></Card>;
  if (error) return <div className="space-y-4"><ErrorBox error={error} onRetry={() => refetch()} />{dailySales}</div>;
  if (isLoading || !data) return <div className="space-y-4"><div className="grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}<Skeleton className="h-72 md:col-span-4" /></div>{localOrders.length > 0 && dailySales}</div>;
  const s = data.summary;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Revenue" value={money(s.revenue)} hint={`Net of tax & service: ${money(s.netSales)}`} icon={<TrendingUp className="h-5 w-5" />} />
        <Stat label="Orders" value={s.orders} hint={`Avg ${money(s.averageOrderValue)}`} icon={<Receipt className="h-5 w-5" />} />
        <Stat label="Discounts" value={money(s.discounts)} hint={`Voids: ${s.voids.count} (${money(s.voids.value)})`} icon={<Percent className="h-5 w-5" />} tone="yellow" />
        <Stat label="Refunds" value={money(s.refunded)} hint={`Tax collected ${money(s.tax)}`} icon={<Wallet className="h-5 w-5" />} tone={s.refunded ? 'red' : 'default'} />
      </div>
      {dailySales}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Sales trend" className="xl:col-span-2" actions={<Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => download('/reports/sales/export', q, 'sales.csv')}>CSV</Button>}>
          <div className="h-64"><ResponsiveContainer><AreaChart data={data.trend}><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#07963C" stopOpacity={0.35} /><stop offset="100%" stopColor="#07963C" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#E4E8E5" vertical={false} /><XAxis dataKey="_id" tick={{ fontSize: 11 }} /><YAxis tickFormatter={k} tick={{ fontSize: 11 }} width={60} /><Tooltip formatter={(v: number) => money(v)} /><Area dataKey="revenue" stroke="#07963C" fill="url(#g)" strokeWidth={2} /></AreaChart></ResponsiveContainer></div>
        </Card>
        <Card title="Payment methods">
          <div className="h-48"><ResponsiveContainer><PieChart><Pie data={data.payments} dataKey="amount" nameKey="_id" innerRadius={45} outerRadius={75} paddingAngle={2}>{data.payments.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie><Tooltip formatter={(v: number) => money(v)} /></PieChart></ResponsiveContainer></div>
          <ul className="space-y-1 text-sm">{data.payments.map((p, i) => <li key={p._id} className="flex justify-between"><span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />{p._id === 'mpesa' ? 'M-Pesa' : titleCase(p._id)} ({p.count}){p.manual ? <Pill color="yellow">{p.manual} manual</Pill> : null}</span><b>{money(p.amount)}</b></li>)}</ul>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Hourly sales"><div className="h-56"><ResponsiveContainer><BarChart data={data.hourly}><CartesianGrid stroke="#E4E8E5" vertical={false} /><XAxis dataKey="_id" tickFormatter={(h) => `${h}:00`} tick={{ fontSize: 11 }} /><YAxis tickFormatter={k} tick={{ fontSize: 11 }} width={60} /><Tooltip formatter={(v: number) => money(v)} labelFormatter={(h) => `${h}:00`} /><Bar dataKey="revenue" fill="#07963C" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div></Card>
        <Card title="Revenue by category"><div className="h-56"><ResponsiveContainer><BarChart data={data.categories} layout="vertical"><XAxis type="number" tickFormatter={k} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="category" width={100} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: number) => money(v)} /><Bar dataKey="revenue" fill="#2B5FA8" radius={[0, 6, 6, 0]} /></BarChart></ResponsiveContainer></div></Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Best-selling items" className="xl:col-span-1"><DataTable rows={data.topItems} rowKey={(r) => r.name} columns={[{ key: 'n', header: 'Item', render: (r) => r.name }, { key: 'q', header: 'Qty', render: (r) => r.qty }, { key: 'r', header: 'Revenue', render: (r) => money(r.revenue) }]} /></Card>
        <Card title="By cashier"><DataTable rows={data.byCashier} rowKey={(r) => String(r._id)} columns={[{ key: 'n', header: 'Cashier', render: (r) => r.name ?? '—' }, { key: 'o', header: 'Orders', render: (r) => r.orders }, { key: 'r', header: 'Revenue', render: (r) => money(r.revenue) }]} /></Card>
        <Card title={`Tips · ${money(data.tips?.total ?? 0)}`}><DataTable rows={data.tips?.byStaff ?? []} rowKey={(r) => r.userId} empty="No tips in this period" columns={[{ key: 'n', header: 'Staff', render: (r) => r.name }, { key: 'c', header: 'Cash', render: (r) => money(r.cash) }, { key: 'm', header: 'M-Pesa', render: (r) => money(r.mpesa) }, { key: 't', header: 'Total', render: (r) => <b>{money(r.total)}</b> }]} /></Card>
        <Card title="By outlet"><DataTable rows={data.byOutlet ?? []} rowKey={(r) => r.outlet} columns={[{ key: 'n', header: 'Outlet', render: (r) => (r.outlet === 'bar' ? 'Bar POS' : 'Restaurant POS') }, { key: 'o', header: 'Orders', render: (r) => r.orders }, { key: 'r', header: 'Revenue', render: (r) => money(r.revenue) }]} /></Card>
        <Card title="By waiter"><DataTable rows={data.byWaiter} rowKey={(r) => String(r._id)} columns={[{ key: 'n', header: 'Waiter', render: (r) => r.name ?? '—' }, { key: 'o', header: 'Orders', render: (r) => r.orders }, { key: 'r', header: 'Revenue', render: (r) => money(r.revenue) }]} /></Card>
      </div>
    </div>
  );
}

function Inventory({ q }: { q: Record<string, string | undefined> }) {
  const { data, isLoading, error } = useQuery<{ valuation: { total: number; items: Array<{ ingredient: string; qty: number; unit: string; value: number }> }; cogs: number; wastageCost: number; complimentaryCost: number; consumption: Array<{ ingredient: string; unit: string; type: string; qty: number; cost: number }>; wastage: Array<{ ingredient: string; unit: string; type: string; qty: number; cost: number }>; barVariance: Array<{ ingredient: string; unit: string; theoreticalUsage: number; countVariance: number; variancePct: number | null }>; lowStock: Array<{ name: string; qty: number; unit: string; min: number }> }>({ queryKey: ['report-inv', q], queryFn: () => get('/reports/inventory', q) });
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-72" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Stock value" value={money(Math.round(data.valuation.total))} icon={<Package className="h-5 w-5" />} />
        <Stat label="Cost of goods sold" value={money(Math.round(data.cogs))} icon={<TrendingUp className="h-5 w-5" />} />
        <Stat label="Wastage cost" value={money(Math.round(data.wastageCost))} icon={<AlertTriangle className="h-5 w-5" />} tone="red" />
        <Stat label="Low stock items" value={data.lowStock.length} icon={<AlertTriangle className="h-5 w-5" />} tone={data.lowStock.length ? 'yellow' : 'default'} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Ingredient consumption"><DataTable rows={data.consumption} rowKey={(r) => r.ingredient + r.type} columns={[{ key: 'i', header: 'Ingredient', render: (r) => r.ingredient }, { key: 't', header: 'Type', render: (r) => titleCase(r.type) }, { key: 'q', header: 'Qty', render: (r) => `${Math.round(r.qty)} ${r.unit}` }, { key: 'c', header: 'Cost', render: (r) => money(Math.round(r.cost)) }]} /></Card>
        <Card title="Bar consumption vs count variance"><DataTable rows={data.barVariance} rowKey={(r) => r.ingredient} columns={[{ key: 'i', header: 'Item', render: (r) => r.ingredient }, { key: 'u', header: 'Theoretical usage', render: (r) => `${Math.round(r.theoreticalUsage)} ${r.unit}` }, { key: 'v', header: 'Count variance', render: (r) => `${Math.round(r.countVariance)} ${r.unit}` }, { key: 'p', header: '%', render: (r) => (r.variancePct === null ? '—' : <Pill color={Math.abs(r.variancePct) > 5 ? 'red' : 'green'}>{r.variancePct}%</Pill>) }]} /></Card>
        <Card title="Wastage"><DataTable rows={data.wastage} rowKey={(r) => r.ingredient + r.type} columns={[{ key: 'i', header: 'Ingredient', render: (r) => r.ingredient }, { key: 't', header: 'Type', render: (r) => titleCase(r.type) }, { key: 'q', header: 'Qty', render: (r) => `${Math.round(r.qty)} ${r.unit}` }, { key: 'c', header: 'Cost', render: (r) => money(Math.round(r.cost)) }]} /></Card>
        <Card title="Low stock"><DataTable rows={data.lowStock} rowKey={(r) => r.name} columns={[{ key: 'n', header: 'Item', render: (r) => r.name }, { key: 'q', header: 'On hand', render: (r) => `${Math.round(r.qty)} ${r.unit}` }, { key: 'm', header: 'Min', render: (r) => r.min }]} /></Card>
      </div>
      <Card title="Stock valuation"><DataTable rows={data.valuation.items} rowKey={(r) => r.ingredient} columns={[{ key: 'i', header: 'Ingredient', render: (r) => r.ingredient }, { key: 'q', header: 'Qty', render: (r) => `${Math.round(r.qty * 100) / 100} ${r.unit}` }, { key: 'v', header: 'Value', render: (r) => money(Math.round(r.value)) }]} /></Card>
    </div>
  );
}

function KitchenTables({ q }: { q: Record<string, string | undefined> }) {
  const kitchen = useQuery<Array<{ _id: string; tickets: number; avgMinutes: number; maxMinutes: number; over15: number }>>({ queryKey: ['report-kitchen', q], queryFn: () => get('/reports/kitchen', q) });
  const tables = useQuery<{ tables: number; rows: Array<{ _id: string; table: string; turns: number; revenue: number; guests: number; avgMinutes: number }> }>({ queryKey: ['report-tables', q], queryFn: () => get('/reports/tables', q) });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Preparation times"><DataTable rows={kitchen.data} loading={kitchen.isLoading} rowKey={(r) => r._id} columns={[{ key: 's', header: 'Station', render: (r) => titleCase(r._id) }, { key: 't', header: 'Tickets', render: (r) => r.tickets }, { key: 'a', header: 'Average', render: (r) => `${Math.round(r.avgMinutes)} min` }, { key: 'm', header: 'Slowest', render: (r) => `${Math.round(r.maxMinutes)} min` }, { key: 'o', header: '> 15 min', render: (r) => r.over15 }]} /></Card>
      <Card title={`Table turnover (${tables.data?.tables ?? 0} tables)`}><DataTable rows={tables.data?.rows} loading={tables.isLoading} rowKey={(r) => String(r._id)} columns={[{ key: 't', header: 'Table', render: (r) => r.table }, { key: 'n', header: 'Turns', render: (r) => r.turns }, { key: 'g', header: 'Guests', render: (r) => r.guests }, { key: 'd', header: 'Avg stay', render: (r) => `${Math.round(r.avgMinutes)} min` }, { key: 'r', header: 'Revenue', render: (r) => money(r.revenue) }]} /></Card>
    </div>
  );
}
