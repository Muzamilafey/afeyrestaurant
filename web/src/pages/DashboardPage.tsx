import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Armchair, Banknote, BarChart3, CheckCircle2, ChefHat, ClipboardList, Clock, LayoutGrid, Minus, Package, ReceiptText, RefreshCw, Smartphone, Table2, Undo2, Users, Wallet, Wine,
} from 'lucide-react';
import { get } from '@/lib/api';
import { onSocket } from '@/lib/socket';
import { useAuth } from '@/auth/AuthContext';
import { Button, Card, ErrorBox, Select, Skeleton, cx } from '@/components/ui';
import { money, titleCase } from '@/lib/format';

type Range = 'today' | 'yesterday' | '7d' | '30d';
interface Kpi { revenue: number; orders: number; guests: number; aov: number; discounts: number; tax: number }
interface Dashboard {
  range: { key: Range; from: string; to: string; granularity: 'hour' | 'day'; timezone: string };
  branches: Array<{ id: string; name: string }>;
  kpis: { current: Kpi; previous: Kpi };
  trend: Array<{ key: string | number; label: string; current: number; previous: number; orders: number }>;
  hourly: Array<{ hour: number; revenue: number; orders: number }>;
  payments: Array<{ method: string; amount: number; count: number }>;
  byType: Array<{ type: string; revenue: number; orders: number }>;
  topItems: Array<{ name: string; qty: number; revenue: number }>;
  staff: Array<{ name: string; revenue: number; orders: number }>;
  live: { openOrders: number; openOrdersValue: number; tables: { total: number; occupied: number }; kitchen: number; bar: number; delayedTickets: number; delayMinutes: number; openDrawers: number; pendingMpesa: number };
  attention: { lowStock: Array<{ name: string; qty: number; unit?: string; min?: number }>; lowStockCount: number; voids: { count: number; value: number }; refunds: { count: number; amount: number }; discounts: number };
}

const RANGES: Array<{ id: Range; label: string; vs: string; current: string }> = [
  { id: 'today', label: 'Today', vs: 'same time yesterday', current: 'Today' },
  { id: 'yesterday', label: 'Yesterday', vs: 'the day before', current: 'Yesterday' },
  { id: '7d', label: '7 days', vs: 'previous 7 days', current: 'Last 7 days' },
  { id: '30d', label: '30 days', vs: 'previous 30 days', current: 'Last 30 days' },
];
const PREVIOUS_LABEL: Record<Range, string> = { today: 'Yesterday', yesterday: 'Day before', '7d': 'Previous 7 days', '30d': 'Previous 30 days' };

/** Compact money for axes and tiles: KSh 12.4k, KSh 1.2M. */
const kmoney = (cents: number) => {
  const v = cents / 100;
  if (Math.abs(v) >= 1_000_000) return `KSh ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(v) >= 10_000) return `KSh ${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return `KSh ${Math.round(v).toLocaleString('en-KE')}`;
};
const axisMoney = (cents: number) => {
  const v = cents / 100;
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
};
const METHOD: Record<string, { label: string; icon: typeof Banknote }> = {
  cash: { label: 'Cash', icon: Banknote },
  mpesa: { label: 'M-Pesa', icon: Smartphone },
  card: { label: 'Card', icon: Wallet },
  qr: { label: 'QR', icon: Wallet },
  account: { label: 'Customer account', icon: Users },
  voucher: { label: 'Voucher', icon: ReceiptText },
};
const TYPE_ICON: Record<string, typeof Banknote> = { dine_in: Armchair, takeaway: Package, delivery: Package, bar_counter: Wine, room_service: Table2, online: Smartphone };

/** Chart colours come from theme tokens so light and dark each use their own validated steps. */
function useVizColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => `rgb(${cs.getPropertyValue(name).trim().split(/\s+/).join(',')})`;
    return { current: v('--c-viz-1'), previous: v('--c-viz-2'), grid: v('--c-line'), ink: v('--c-ink-soft'), card: v('--c-card') };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setC(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => obs.disconnect();
  }, []);
  return c;
}

function greeting(tz: string) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Percentage change, or null when there is nothing to compare against. */
const change = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

function Delta({ cur, prev, vs, onBrand }: { cur: number; prev: number; vs: string; onBrand?: boolean }) {
  const pct = change(cur, prev);
  if (pct === null) return <span className={cx('text-xs', onBrand ? 'text-white/75' : 'text-ink-soft')}>{cur > 0 ? `New vs ${vs}` : `Nothing vs ${vs}`}</span>;
  const up = pct > 0.5;
  const down = pct < -0.5;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <span
        className={cx(
          'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold',
          onBrand ? 'bg-white/20 text-white' : up ? 'bg-brand-pale text-brand-dark dark:text-brand' : down ? 'bg-danger-pale text-danger' : 'bg-page text-ink-soft',
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {Math.abs(pct) >= 1000 ? '>999' : Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%
      </span>
      <span className={onBrand ? 'text-white/75' : 'text-ink-soft'}>vs {vs}</span>
    </span>
  );
}

function Sparkline({ data, dataKey, color }: { data: Array<Record<string, number | string>>; dataKey: string; color: string }) {
  const id = `spark-${dataKey}`;
  return (
    <div className="h-10 w-20 shrink sm:w-24" aria-hidden>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiTile({ label, value, cur, prev, vs, icon, hero, spark }: { label: string; value: string; cur: number; prev: number; vs: string; icon: ReactNode; hero?: boolean; spark?: ReactNode }) {
  return (
    <div className={cx('relative overflow-hidden rounded-2xl p-5 shadow-soft', hero ? 'bg-gradient-to-br from-brand to-brand-dark text-white' : 'border border-line bg-card')}>
      {hero && <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10" aria-hidden />}
      <div className="flex items-center gap-2">
        <span className={cx('grid h-8 w-8 place-items-center rounded-xl', hero ? 'bg-white/15' : 'bg-brand-pale text-brand')}>{icon}</span>
        <span className={cx('text-sm font-medium', hero ? 'text-white/85' : 'text-ink-soft')}>{label}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="whitespace-nowrap text-2xl font-bold tabular-nums tracking-tight xl:text-[26px] 2xl:text-[28px]">{value}</p>
        {spark}
      </div>
      <div className="mt-2">
        <Delta cur={cur} prev={prev} vs={vs} onBrand={hero} />
      </div>
    </div>
  );
}

/** Ranked rows with a thin magnitude bar — one measure, one hue, labels always visible. */
function BarList({ rows, empty }: { rows: Array<{ key: string; label: ReactNode; value: number; sub?: ReactNode; icon?: ReactNode }>; empty: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  if (!rows.length) return <p className="py-8 text-center text-sm text-ink-soft">{empty}</p>;
  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              {r.icon}
              <span className="truncate">{r.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              <b>{kmoney(r.value)}</b> <span className="text-xs text-ink-soft">· {Math.round((r.value / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-page">
            <div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
          {r.sub && <p className="mt-1 text-xs text-ink-soft">{r.sub}</p>}
        </li>
      ))}
    </ul>
  );
}

function LiveRow({ icon, label, value, sub, to, tone }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; to?: string; tone?: 'danger' | 'warn' }) {
  const body = (
    <div className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-page">
      <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl', tone === 'danger' ? 'bg-danger-pale text-danger' : tone === 'warn' ? 'bg-warn-pale text-warn-ink' : 'bg-brand-pale text-brand')}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {sub && <div className="text-xs text-ink-soft">{sub}</div>}
      </div>
      <span className="text-lg font-bold tabular-nums">{value}</span>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function TrendTooltip({ active, payload, label, currentName, previousName }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color: string }>; label?: string; currentName: string; previousName: string }) {
  if (!active || !payload?.length) return null;
  const cur = payload.find((p) => p.dataKey === 'current')?.value ?? 0;
  const prev = payload.find((p) => p.dataKey === 'previous')?.value ?? 0;
  const pct = change(cur, prev);
  return (
    <div className="rounded-xl border border-line bg-card px-3 py-2 text-xs shadow-lift">
      <p className="mb-1 font-semibold">{label}</p>
      <p className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-3 rounded" style={{ background: payload.find((p) => p.dataKey === 'current')?.color }} />{currentName}</span><b className="tabular-nums">{money(cur)}</b></p>
      <p className="flex items-center justify-between gap-4 text-ink-soft"><span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t-2 border-dashed" style={{ borderColor: payload.find((p) => p.dataKey === 'previous')?.color }} />{previousName}</span><span className="tabular-nums">{money(prev)}</span></p>
      {pct !== null && <p className={cx('mt-1 font-semibold', pct >= 0 ? 'text-brand' : 'text-danger')}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const colors = useVizColors();
  const [range, setRange] = useState<Range>(() => {
    try {
      return (localStorage.getItem('chili.dashboard.range') as Range) || 'today';
    } catch {
      return 'today';
    }
  });
  const [branch, setBranch] = useState<string>('');
  const [asTable, setAsTable] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('chili.dashboard.range', range);
    } catch {
      /* private mode */
    }
  }, [range]);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery<Dashboard>({
    queryKey: ['dashboard', range, branch],
    queryFn: () => get('/dashboard', { range, ...(branch ? { branchId: branch } : {}) }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  // Live: a payment or order change anywhere in the branch refreshes the numbers (at most every few seconds).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => qc.invalidateQueries({ queryKey: ['dashboard'] }), 2500);
    };
    const offs = ['payment.updated', 'order.updated', 'ticket.created', 'ticket.updated', 'table.updated'].map((e) => onSocket(e, bump));
    return () => {
      clearTimeout(t);
      offs.forEach((off) => off());
    };
  }, [qc]);

  const meta = RANGES.find((r) => r.id === range)!;
  const tz = data?.range.timezone ?? 'Africa/Nairobi';
  const firstName = session?.user.name?.split(/\s+/)[0] ?? '';
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const peak = useMemo(() => (data?.hourly.length ? data.hourly.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null), [data]);
  const hours = useMemo(() => {
    if (!data?.hourly.length) return [];
    const lo = Math.min(...data.hourly.map((h) => h.hour));
    const hi = Math.max(...data.hourly.map((h) => h.hour));
    return Array.from({ length: hi - lo + 1 }, (_, i) => data.hourly.find((h) => h.hour === lo + i) ?? { hour: lo + i, revenue: 0, orders: 0 });
  }, [data]);
  const hasSales = (data?.kpis.current.orders ?? 0) > 0;
  const branchOptions = session?.branches ?? [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm text-ink-soft">{today}</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {greeting(tz)}{firstName ? `, ${firstName}` : ''} 👋
          </h1>
          <p className="mt-1 text-sm text-ink-soft">Here’s how the business is doing{data?.branches.length === 1 ? ` at ${data.branches[0].name}` : data && data.branches.length > 1 ? ' across all branches' : ''}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Period" className="flex rounded-xl border border-line bg-card p-1 shadow-soft">
            {RANGES.map((r) => (
              <button
                key={r.id}
                role="tab"
                aria-selected={range === r.id}
                onClick={() => setRange(r.id)}
                className={cx('rounded-lg px-3 py-1.5 text-sm font-semibold transition', range === r.id ? 'bg-brand text-white shadow-sm' : 'text-ink-soft hover:text-ink')}
              >
                {r.label}
              </button>
            ))}
          </div>
          {branchOptions.length > 1 && (
            <Select aria-label="Branch" className="!h-[42px] !w-auto" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">Current branch</option>
              <option value="all">All branches</option>
              {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          )}
          <Button variant="secondary" size="sm" className="!h-[42px]" icon={<RefreshCw className={cx('h-4 w-4', isFetching && 'animate-spin')} />} onClick={() => refetch()} aria-label="Refresh" />
        </div>
      </div>

      {error && !data ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>
          <div className="grid gap-4 xl:grid-cols-3"><Skeleton className="h-80 xl:col-span-2" /><Skeleton className="h-80" /></div>
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile hero label="Revenue" icon={<Banknote className="h-4 w-4" />} value={kmoney(data.kpis.current.revenue)} cur={data.kpis.current.revenue} prev={data.kpis.previous.revenue} vs={meta.vs} spark={<Sparkline data={data.trend} dataKey="current" color="#ffffff" />} />
            <KpiTile label="Orders" icon={<ReceiptText className="h-4 w-4" />} value={data.kpis.current.orders.toLocaleString('en-KE')} cur={data.kpis.current.orders} prev={data.kpis.previous.orders} vs={meta.vs} spark={<Sparkline data={data.trend} dataKey="orders" color={colors.current} />} />
            <KpiTile label="Average order" icon={<BarChart3 className="h-4 w-4" />} value={kmoney(data.kpis.current.aov)} cur={data.kpis.current.aov} prev={data.kpis.previous.aov} vs={meta.vs} />
            <KpiTile label="Guests served" icon={<Users className="h-4 w-4" />} value={data.kpis.current.guests.toLocaleString('en-KE')} cur={data.kpis.current.guests} prev={data.kpis.previous.guests} vs={meta.vs} />
          </div>

          {/* Trend + live */}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card
              className="xl:col-span-2"
              title={<span>Revenue {data.range.granularity === 'hour' ? 'by hour' : 'by day'}</span>}
              actions={
                <div className="flex items-center gap-4 text-xs text-ink-soft">
                  <span className="hidden items-center gap-1.5 sm:flex"><i className="inline-block h-[3px] w-4 rounded" style={{ background: colors.current }} />{meta.current}</span>
                  <span className="hidden items-center gap-1.5 sm:flex"><i className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: colors.previous }} />{PREVIOUS_LABEL[range]}</span>
                  <button className="font-semibold text-brand" onClick={() => setAsTable(!asTable)}>{asTable ? 'Chart' : 'Table'}</button>
                </div>
              }
            >
              {asTable ? (
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card text-left text-xs uppercase text-ink-soft"><tr><th className="py-2">{data.range.granularity === 'hour' ? 'Hour' : 'Day'}</th><th className="py-2 text-right">{meta.current}</th><th className="py-2 text-right">{PREVIOUS_LABEL[range]}</th></tr></thead>
                    <tbody>{data.trend.map((t) => <tr key={String(t.key)} className="border-t border-line"><td className="py-1.5">{t.label}</td><td className="py-1.5 text-right tabular-nums">{money(t.current)}</td><td className="py-1.5 text-right tabular-nums text-ink-soft">{money(t.previous)}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : (
                <div className="relative h-72">
                  {!hasSales && !data.trend.some((t) => t.previous > 0) && (
                    <div className="absolute inset-0 z-10 grid place-items-center">
                      <div className="rounded-xl bg-card/90 px-4 py-3 text-center text-sm text-ink-soft shadow-soft">No sales {range === 'today' ? 'yet today' : 'in this period'} — they appear here as soon as orders are paid.</div>
                    </div>
                  )}
                  <ResponsiveContainer>
                    <ComposedChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="dash-current" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={colors.current} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={colors.current} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={colors.grid} strokeDasharray="0" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: colors.ink }} tickLine={false} axisLine={{ stroke: colors.grid }} interval="preserveStartEnd" minTickGap={16} />
                      <YAxis tickFormatter={axisMoney} tick={{ fontSize: 11, fill: colors.ink }} tickLine={false} axisLine={false} width={44} />
                      <Tooltip cursor={{ stroke: colors.ink, strokeWidth: 1, strokeDasharray: '3 3' }} content={<TrendTooltip currentName={meta.current} previousName={PREVIOUS_LABEL[range]} />} />
                      <Line type="monotone" dataKey="previous" stroke={colors.previous} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, stroke: colors.card, strokeWidth: 2 }} isAnimationActive={false} />
                      <Area type="monotone" dataKey="current" stroke={colors.current} strokeWidth={2} fill="url(#dash-current)" dot={false} activeDot={{ r: 5, stroke: colors.card, strokeWidth: 2 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card
              title={<span className="flex items-center gap-2">Right now <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand" /></span></span>}
              actions={<span className="text-xs text-ink-soft">Updated {new Date(dataUpdatedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</span>}
            >
              <div className="-mx-2 -my-1">
                <LiveRow to="/orders" icon={<ClipboardList className="h-4 w-4" />} label="Open orders" sub={`${kmoney(data.live.openOrdersValue)} not yet paid`} value={data.live.openOrders} />
                <LiveRow
                  to="/tables"
                  icon={<Armchair className="h-4 w-4" />}
                  label="Tables occupied"
                  sub={data.live.tables.total ? <div className="mt-1 h-1.5 w-32 rounded-full bg-page"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${(data.live.tables.occupied / data.live.tables.total) * 100}%` }} /></div> : 'No tables set up'}
                  value={<>{data.live.tables.occupied}<span className="text-sm font-medium text-ink-soft">/{data.live.tables.total}</span></>}
                />
                <LiveRow to="/kitchen" icon={<ChefHat className="h-4 w-4" />} label="Kitchen tickets" sub={data.live.delayedTickets ? <span className="font-semibold text-danger">{data.live.delayedTickets} waiting over {data.live.delayMinutes} min</span> : 'All on time'} value={data.live.kitchen} tone={data.live.delayedTickets ? 'danger' : undefined} />
                <LiveRow to="/bar" icon={<Wine className="h-4 w-4" />} label="Bar tickets" value={data.live.bar} />
                <LiveRow to="/accounting" icon={<Wallet className="h-4 w-4" />} label="Cash drawers open" sub={data.live.pendingMpesa ? `${data.live.pendingMpesa} M-Pesa payment${data.live.pendingMpesa > 1 ? 's' : ''} waiting` : undefined} value={data.live.openDrawers} tone={data.live.pendingMpesa ? 'warn' : undefined} />
              </div>
            </Card>
          </div>

          {/* Breakdown row */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Top sellers" actions={<Link to="/reports" className="text-xs font-semibold text-brand">All items</Link>}>
              {data.topItems.length ? (
                <ol className="space-y-3">
                  {data.topItems.map((it, i) => {
                    const max = data.topItems[0].revenue || 1;
                    return (
                      <li key={it.name} className="flex items-center gap-3">
                        <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-bold', i === 0 ? 'bg-brand text-white' : 'bg-page text-ink-soft')}>{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="truncate font-medium">{it.name}</span>
                            <b className="shrink-0 tabular-nums">{kmoney(it.revenue)}</b>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-page"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(3, (it.revenue / max) * 100)}%` }} /></div>
                            <span className="shrink-0 whitespace-nowrap text-right text-xs text-ink-soft tabular-nums">{it.qty.toLocaleString('en-KE')} sold</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="py-8 text-center text-sm text-ink-soft">Best sellers show up after the first paid order.</p>
              )}
            </Card>
            <Card title="How guests paid">
              <BarList
                empty="No payments in this period"
                rows={data.payments.map((p) => {
                  const m = METHOD[p.method] ?? { label: titleCase(p.method), icon: Wallet };
                  return { key: p.method, label: m.label, value: p.amount, icon: <m.icon className="h-4 w-4 text-ink-soft" />, sub: `${p.count} payment${p.count === 1 ? '' : 's'}` };
                })}
              />
            </Card>
            <Card title="Sales by service">
              <BarList
                empty="No paid orders in this period"
                rows={data.byType.map((t) => {
                  const Icon = TYPE_ICON[t.type] ?? LayoutGrid;
                  return { key: t.type, label: titleCase(t.type), value: t.revenue, icon: <Icon className="h-4 w-4 text-ink-soft" />, sub: `${t.orders} order${t.orders === 1 ? '' : 's'}` };
                })}
              />
            </Card>
          </div>

          {/* Busiest hours + attention + staff */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Busiest hours" actions={peak && <span className="inline-flex items-center gap-1 text-xs text-ink-soft"><Clock className="h-3.5 w-3.5" /> Peak {String(peak.hour).padStart(2, '0')}:00</span>}>
              {hours.length ? (
                <div className="h-56">
                  <ResponsiveContainer>
                    <BarChart data={hours} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
                      <CartesianGrid stroke={colors.grid} vertical={false} />
                      <XAxis dataKey="hour" tickFormatter={(h) => `${h}h`} tick={{ fontSize: 11, fill: colors.ink }} tickLine={false} axisLine={{ stroke: colors.grid }} interval="preserveStartEnd" />
                      <YAxis tickFormatter={axisMoney} tick={{ fontSize: 11, fill: colors.ink }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip cursor={{ fill: colors.grid, opacity: 0.5 }} content={({ active, payload }) => (active && payload?.length ? <div className="rounded-xl border border-line bg-card px-3 py-2 text-xs shadow-lift"><p className="font-semibold">{String(payload[0].payload.hour).padStart(2, '0')}:00 – {String(payload[0].payload.hour + 1).padStart(2, '0')}:00</p><p className="tabular-nums">{money(payload[0].payload.revenue)} · {payload[0].payload.orders} orders</p></div> : null)} />
                      <Bar dataKey="revenue" radius={[4, 4, 0, 0]} maxBarSize={28}>
                        {hours.map((h) => <Cell key={h.hour} fill={colors.current} fillOpacity={peak && h.hour === peak.hour ? 1 : 0.55} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="py-16 text-center text-sm text-ink-soft">Shows when your busiest hours are once orders are paid.</p>
              )}
            </Card>

            <Card title="Needs attention">
              {(() => {
                const a = data.attention;
                const items: ReactNode[] = [];
                if (data.live.delayedTickets) items.push(<LiveRow key="late" to="/kitchen" tone="danger" icon={<ChefHat className="h-4 w-4" />} label="Late kitchen tickets" sub={`Waiting over ${data.live.delayMinutes} minutes`} value={data.live.delayedTickets} />);
                if (a.lowStockCount) items.push(<LiveRow key="stock" to="/inventory" tone="warn" icon={<Package className="h-4 w-4" />} label="Low stock" sub={a.lowStock.slice(0, 3).map((s) => s.name).join(', ') + (a.lowStockCount > 3 ? ` +${a.lowStockCount - 3} more` : '')} value={a.lowStockCount} />);
                if (a.voids.count) items.push(<LiveRow key="voids" to="/reports" tone="warn" icon={<AlertTriangle className="h-4 w-4" />} label="Voided items" sub={`${kmoney(a.voids.value)} removed from orders`} value={a.voids.count} />);
                if (a.refunds.count) items.push(<LiveRow key="refunds" to="/accounting" tone="warn" icon={<Undo2 className="h-4 w-4" />} label="Refunds" sub={`${kmoney(a.refunds.amount)} paid back`} value={a.refunds.count} />);
                if (a.discounts) items.push(<LiveRow key="disc" to="/reports" icon={<ReceiptText className="h-4 w-4" />} label="Discounts given" sub={`${data.kpis.current.revenue ? ((a.discounts / (data.kpis.current.revenue + a.discounts)) * 100).toFixed(1) : '0'}% of gross sales`} value={<span className="text-base">{kmoney(a.discounts)}</span>} />);
                return items.length ? (
                  <div className="-mx-2 -my-1">{items}</div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <CheckCircle2 className="h-9 w-9 text-brand" />
                    <p className="font-semibold">All clear</p>
                    <p className="text-sm text-ink-soft">No late tickets, low stock, voids or refunds.</p>
                  </div>
                );
              })()}
            </Card>

            <Card title="Top staff" actions={<span className="text-xs text-ink-soft">by sales</span>}>
              {data.staff.length ? (
                <ul className="space-y-3">
                  {data.staff.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="flex items-center gap-3">
                      <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold', i === 0 ? 'bg-brand text-white' : 'bg-brand-pale text-brand')}>{(s.name ?? '?').trim()[0]?.toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="text-xs text-ink-soft">{s.orders} order{s.orders === 1 ? '' : 's'} · avg {kmoney(Math.round(s.revenue / Math.max(1, s.orders)))}</p>
                      </div>
                      <b className="text-sm tabular-nums">{kmoney(s.revenue)}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-10 text-center text-sm text-ink-soft">Waiter sales appear once orders are paid.</p>
              )}
            </Card>
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2">
            <Link to="/pos"><Button variant="secondary" icon={<LayoutGrid className="h-4 w-4" />}>Open POS</Button></Link>
            <Link to="/reports"><Button variant="secondary" icon={<BarChart3 className="h-4 w-4" />}>Full reports</Button></Link>
            <Link to="/accounting"><Button variant="secondary" icon={<Wallet className="h-4 w-4" />}>Cash & expenses</Button></Link>
          </div>
        </>
      )}
    </div>
  );
}
