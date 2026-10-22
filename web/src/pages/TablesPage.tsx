import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, Sparkles, Move, Check, CalendarDays } from 'lucide-react';
import { get, patch, post } from '@/lib/api';
import { money, time, elapsed } from '@/lib/format';
import { Button, Card, Empty, Input, Modal, Skeleton, StatusPill, Tabs, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface T { _id: string; number: string; capacity: number; status: string; shape: string; areaId?: string; layout?: { x: number; y: number; w: number; h: number }; occupiedSince?: string; orders: Array<{ id: string; number: string; waiterName?: string; total: number; itemCount: number }>; itemCount: number; progress: number }
interface Resp { areas: Array<{ _id: string; name: string }>; tables: T[] }
interface Reservation { _id: string; code: string; customerName: string; partySize: number; startsAt: string; status: string; tableIds: string[]; specialRequests?: string }

const CELL = 112; // px per layout unit
const BAR: Record<string, string> = { available: 'bg-ink-soft/50', reserved: 'bg-brand', occupied: 'bg-warn', cleaning: 'bg-info' };
const LABEL: Record<string, string> = { available: 'Free', reserved: 'Reserved', occupied: 'Checked-in', cleaning: 'Cleaning' };

export default function TablesPage() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const nav = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  const { data, isLoading } = useQuery<Resp>({ queryKey: ['tables'], queryFn: () => get('/tables'), refetchInterval: 15_000 });
  const from = new Date(`${day}T00:00:00`);
  const reservations = useQuery<Reservation[]>({ queryKey: ['reservations', 'day', day], queryFn: () => get('/crm/reservations', { from: from.toISOString(), to: new Date(from.getTime() + 86400_000).toISOString(), status: 'pending,confirmed,seated' }), enabled: can('reservations.view') });
  const [area, setArea] = useState<string>('');
  const [sel, setSel] = useState<T | null>(null);
  const [resSel, setResSel] = useState<Reservation | null>(null);
  const [resTable, setResTable] = useState<string | null>(null);
  const [editLayout, setEditLayout] = useState(false);
  useEffect(() => { if (!area && data?.areas[0]) setArea(data.areas[0]._id); }, [data, area]);

  const tables = useMemo(() => (data?.tables ?? []).filter((t) => !data?.areas.length || t.areaId === area), [data, area]);
  const nextRes = (t: T) => (reservations.data ?? []).filter((r) => r.tableIds.includes(t._id) && r.status !== 'seated').sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const stats = useMemo(() => {
    const all = data?.tables ?? [];
    const seats = (s: string) => all.filter((t) => t.status === s).reduce((a, t) => a + t.capacity, 0);
    const total = all.reduce((a, t) => a + t.capacity, 0);
    return { free: seats('available'), reserved: seats('reserved'), checkedIn: seats('occupied'), total, tables: all.length, busyTables: all.filter((t) => t.status === 'occupied').length };
  }, [data]);

  const setStatus = (t: T, status: string) => post(`/tables/${t._id}/status`, { status }).then(() => { qc.invalidateQueries({ queryKey: ['tables'] }); setSel(null); toast(`Table ${t.number} is ${LABEL[status]?.toLowerCase() ?? status}`); }).catch(handleError);
  const checkIn = async () => {
    if (!resSel) return;
    const tableId = resTable ?? resSel.tableIds[0];
    if (!tableId) return toast('Tap a table on the plan for this reservation', 'error');
    try {
      if (!resSel.tableIds.includes(tableId)) await patch(`/crm/reservations/${resSel._id}`, { tableIds: [tableId] });
      await post(`/crm/reservations/${resSel._id}/status`, { status: 'seated', notify: false });
      qc.invalidateQueries({ queryKey: ['tables'] });
      qc.invalidateQueries({ queryKey: ['reservations'] });
      toast(`${resSel.customerName} checked in`);
      setResSel(null);
      setResTable(null);
      if (can('orders.create')) nav(`/pos?table=${tableId}`);
    } catch (e) {
      handleError(e);
    }
  };

  const onTableClick = (t: T) => {
    if (editLayout) return;
    if (resSel) return setResTable(t._id);
    setSel(t);
  };

  const maxX = Math.max(6, ...tables.map((t) => (t.layout?.x ?? 0) + (t.layout?.w ?? 1)));
  const maxY = Math.max(3, ...tables.map((t) => (t.layout?.y ?? 0) + (t.layout?.h ?? 1)));

  return (
    <div className="flex h-full flex-col gap-4 xl:flex-row">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-xl font-bold">Table services</h1>
          {can('tables.manage') && <Button variant={editLayout ? 'primary' : 'secondary'} size="sm" icon={editLayout ? <Check className="h-4 w-4" /> : <Move className="h-4 w-4" />} onClick={() => setEditLayout(!editLayout)}>{editLayout ? 'Done arranging' : 'Arrange tables'}</Button>}
          <div className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-ink-soft" /><Input type="date" className="w-40" value={day} onChange={(e) => setDay(e.target.value)} /></div>
        </div>
        {(data?.areas.length ?? 0) > 0 && <Tabs tabs={data!.areas.map((a) => ({ id: a._id, label: a.name }))} value={area} onChange={setArea} />}
        <Card padded={false} className="overflow-hidden">
          {isLoading ? <Skeleton className="m-5 h-80" /> : tables.length === 0 ? <Empty title="No tables in this area" hint="Add tables in Settings → Tables." /> : (
            <div className="scroll-thin overflow-auto p-5">
              <div className={cx('relative rounded-xl', editLayout && 'bg-[linear-gradient(rgb(var(--c-line))_1px,transparent_1px),linear-gradient(90deg,rgb(var(--c-line))_1px,transparent_1px)]')} style={{ width: maxX * CELL + 8, height: maxY * CELL + 8, backgroundSize: `${CELL}px ${CELL}px` }}>
                {tables.map((t) => <TableTile key={t._id} t={t} nextRes={nextRes(t)} selected={resTable === t._id || sel?._id === t._id} editable={editLayout} onClick={() => onTableClick(t)} onMoved={(layout) => patch(`/tables/${t._id}`, { layout }).then(() => qc.invalidateQueries({ queryKey: ['tables'] })).catch(handleError)} />)}
              </div>
            </div>
          )}
          <footer className="grid items-center gap-4 border-t border-line p-4 md:grid-cols-[minmax(300px,1.4fr)_1fr_1fr]">
            <div className="rounded-xl border border-line px-3 py-2">
              <p className="text-xs font-semibold text-ink-soft">Seats</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"><span className="flex items-center gap-1.5 whitespace-nowrap"><Dot c="bg-ink-soft/50" /> Free <b>{stats.free}</b></span><span className="flex items-center gap-1.5 whitespace-nowrap"><Dot c="bg-brand" /> Reserved <b>{stats.reserved}</b></span><span className="flex items-center gap-1.5 whitespace-nowrap"><Dot c="bg-warn" /> Checked-in <b>{stats.checkedIn}</b></span></p>
            </div>
            <Meter label="Tables in use" value={stats.busyTables} max={stats.tables} />
            <Meter label="Seats in use" value={stats.checkedIn} max={stats.total} />
          </footer>
        </Card>
      </div>

      {can('reservations.view') && (
        <aside className="w-full shrink-0 xl:w-[340px]">
          <Card padded={false} className="flex h-full flex-col">
            <div className="border-b border-line p-4">
              <p className="font-semibold">Table management</p>
              <p className="text-xs text-ink-soft">{new Date(`${day}T12:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })} · {time(new Date())}</p>
            </div>
            <div className="scroll-thin flex-1 overflow-y-auto p-3">
              <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Reservations</p>
              {reservations.isLoading ? <Skeleton className="h-24" /> : !(reservations.data ?? []).length ? <p className="px-1 text-sm text-ink-soft">No reservations for this day.</p> : (
                <ul className="space-y-1.5">
                  {(reservations.data ?? []).map((r) => {
                    const tableNo = data?.tables.find((t) => t._id === (resSel?._id === r._id && resTable ? resTable : r.tableIds[0]))?.number;
                    return (
                      <li key={r._id}>
                        <button disabled={r.status === 'seated'} onClick={() => { setResSel(resSel?._id === r._id ? null : r); setResTable(null); }} className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', resSel?._id === r._id ? 'bg-brand-pale' : 'hover:bg-page', r.status === 'seated' && 'opacity-50')}>
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line text-[11px] font-bold">{tableNo ?? '—'}</span>
                          <span className="min-w-0 flex-1 truncate font-medium">{r.customerName}</span>
                          <span className="text-xs text-ink-soft">×{r.partySize}</span>
                          <span className="border-l border-line pl-2 text-xs tabular-nums">{time(r.startsAt)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {resSel && <p className="mt-3 rounded-xl bg-page px-3 py-2 text-xs text-ink-soft">{resTable || resSel.tableIds[0] ? 'Ready to check in. Tap another table to change it.' : 'Tap a free table on the plan for this party.'}{resSel.specialRequests ? ` · “${resSel.specialRequests}”` : ''}</p>}
            </div>
            <div className="flex gap-2 border-t border-line p-3">
              <Button variant="ghost" className="flex-1" disabled={!resSel} onClick={() => { setResSel(null); setResTable(null); }}>Cancel</Button>
              <Button className="flex-1" disabled={!resSel || !can('reservations.manage')} onClick={checkIn}>Check-in</Button>
            </div>
          </Card>
        </aside>
      )}

      {sel && (
        <Modal open onClose={() => setSel(null)} title={`Table ${sel.number}`} footer={
          <>
            {sel.status === 'cleaning' && <Button variant="secondary" icon={<Sparkles className="h-4 w-4" />} onClick={() => setStatus(sel, 'available')}>Mark clean</Button>}
            {sel.status === 'available' && <Button variant="secondary" onClick={() => setStatus(sel, 'reserved')}>Mark reserved</Button>}
            {sel.status === 'reserved' && <Button variant="secondary" onClick={() => setStatus(sel, 'available')}>Release</Button>}
            {can('orders.create') && <Button onClick={() => nav(`/pos?table=${sel._id}`)}>New order here</Button>}
          </>
        }>
          <p className="mb-3 flex items-center gap-2 text-sm text-ink-soft"><Users className="h-4 w-4" /> {sel.capacity} seats · <StatusPill status={sel.status} />{sel.occupiedSince && ` · seated ${elapsed((Date.now() - new Date(sel.occupiedSince).getTime()) / 1000)} ago`}</p>
          {sel.orders.length === 0 ? <p className="text-sm text-ink-soft">No open orders on this table.</p> : (
            <div className="space-y-2">{sel.orders.map((o) => <Card key={o.id} padded={false} className="flex items-center justify-between px-4 py-3"><div><p className="font-semibold">{o.number}</p><p className="text-xs text-ink-soft">{o.waiterName} · {o.itemCount} items</p></div><div className="flex items-center gap-2"><b>{money(o.total)}</b>{can('orders.create') && <Button size="sm" onClick={() => nav(`/pos?order=${o.id}`)}>Open</Button>}</div></Card>)}</div>
          )}
        </Modal>
      )}
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span className={cx('inline-block h-2 w-2 rounded-full', c)} />;
}
function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="px-1">
      <p className="text-xs font-semibold text-ink-soft">{label}: <span className="text-ink">{value}/{max}</span></p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-page"><div className="h-full rounded-full bg-brand" style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></div>
    </div>
  );
}

/** A table on the plan: coloured status bar, number and status time. Draggable in arrange mode (snaps to the grid). */
function TableTile({ t, nextRes, selected, editable, onClick, onMoved }: { t: T; nextRes?: Reservation; selected: boolean; editable: boolean; onClick: () => void; onMoved: (layout: { x: number; y: number; w: number; h: number }) => void }) {
  const l = t.layout ?? { x: 0, y: 0, w: 1, h: 1 };
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const w = (l.w || 1) * CELL - 12;
  const h = (l.h || 1) * CELL - 12;
  const caption = t.status === 'occupied' ? time(t.occupiedSince) : t.status === 'reserved' || nextRes ? (nextRes ? time(nextRes.startsAt) : '') : t.status === 'cleaning' ? '' : '—';
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => { if (!editable) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY }; setDrag({ dx: 0, dy: 0 }); }}
      onPointerMove={(e) => { if (editable && start.current) setDrag({ dx: e.clientX - start.current.x, dy: e.clientY - start.current.y }); }}
      onPointerUp={() => {
        if (!editable || !start.current || !drag) return;
        const nx = Math.max(0, Math.round(l.x + drag.dx / CELL));
        const ny = Math.max(0, Math.round(l.y + drag.dy / CELL));
        start.current = null;
        setDrag(null);
        if (nx !== l.x || ny !== l.y) onMoved({ ...l, x: nx, y: ny });
      }}
      className={cx('absolute flex overflow-hidden border-2 bg-raised text-left shadow-soft transition-[box-shadow,border-color]', t.shape === 'round' ? 'rounded-[28px]' : 'rounded-xl', selected ? 'border-brand' : 'border-line hover:border-brand/40', editable && 'cursor-move touch-none')}
      style={{ left: l.x * CELL + 6 + (drag?.dx ?? 0), top: l.y * CELL + 6 + (drag?.dy ?? 0), width: w, height: h, zIndex: drag ? 10 : undefined }}
    >
      <span className={cx('w-1.5 shrink-0', BAR[t.status] ?? BAR.available)} />
      <span className="flex flex-1 flex-col justify-between p-2.5">
        <span className="flex items-center justify-between"><span className={cx('text-sm font-bold', t.status === 'reserved' && 'text-brand-dark', t.status === 'occupied' && 'text-warn-ink')}>{t.number}</span><span className="flex items-center gap-0.5 text-[11px] text-ink-soft"><Users className="h-3 w-3" />{t.capacity}</span></span>
        <span>
          <span className="block text-[11px] text-ink-soft">{nextRes && t.status === 'available' ? 'Reserved later' : LABEL[t.status]}</span>
          <span className="block text-sm font-semibold tabular-nums">{caption}</span>
        </span>
      </span>
    </button>
  );
}
