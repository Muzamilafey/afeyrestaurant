import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, Sparkles, Clock } from 'lucide-react';
import { get, post } from '@/lib/api';
import { money, elapsed } from '@/lib/format';
import { Button, Card, Modal, PageHeader, Skeleton, StatusPill, Tabs, cx, Empty } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface T { _id: string; number: string; capacity: number; status: string; shape: string; areaId?: string; layout?: { x: number; y: number }; occupiedSince?: string; orders: Array<{ id: string; number: string; waiterName?: string; total: number; itemCount: number }>; itemCount: number; progress: number }
interface Resp { areas: Array<{ _id: string; name: string }>; tables: T[] }

const COLORS: Record<string, string> = { available: 'border-brand/40 bg-white', occupied: 'border-[#2B5FA8]/50 bg-[#EEF4FC]', reserved: 'border-warn bg-warn-pale', cleaning: 'border-line bg-page' };

export default function TablesPage() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data, isLoading } = useQuery<Resp>({ queryKey: ['tables'], queryFn: () => get('/tables'), refetchInterval: 15_000 });
  const [area, setArea] = useState('all');
  const [sel, setSel] = useState<T | null>(null);
  const tables = useMemo(() => (data?.tables ?? []).filter((t) => area === 'all' || t.areaId === area), [data, area]);
  const counts = useMemo(() => (data?.tables ?? []).reduce((a: Record<string, number>, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {}), [data]);

  const setStatus = (t: T, status: string) => post(`/tables/${t._id}/status`, { status }).then(() => { qc.invalidateQueries({ queryKey: ['tables'] }); setSel(null); toast(`Table ${t.number} is ${status}`); }).catch(handleError);

  return (
    <div>
      <PageHeader title="Table services" subtitle="Live floor plan. Tap a table to open, view or manage it." actions={<div className="flex flex-wrap gap-2 text-xs">{['available', 'occupied', 'reserved', 'cleaning'].map((s) => <span key={s} className="flex items-center gap-1"><StatusPill status={s} /> {counts[s] ?? 0}</span>)}</div>} />
      <Tabs tabs={[{ id: 'all', label: 'All areas' }, ...(data?.areas ?? []).map((a) => ({ id: a._id, label: a.name }))]} value={area} onChange={setArea} />
      {isLoading ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div> : tables.length === 0 ? <Empty title="No tables" hint="Add tables in Settings → Tables." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {tables.map((t) => (
            <button key={t._id} onClick={() => setSel(t)} className={cx('flex min-h-[132px] flex-col gap-2 border-2 p-3 text-left shadow-soft transition hover:shadow-lift', t.shape === 'round' ? 'rounded-[28px]' : 'rounded-2xl', COLORS[t.status])}>
              <div className="flex items-center justify-between"><span className="text-lg font-bold">T-{t.number}</span><StatusPill status={t.status} /></div>
              <span className="flex items-center gap-1 text-xs text-ink-soft"><Users className="h-3.5 w-3.5" /> {t.capacity} seats</span>
              {t.orders.length > 0 && (
                <>
                  <span className="text-xs">{t.orders[0].waiterName} · {money(t.orders.reduce((s, o) => s + o.total, 0))}</span>
                  {t.occupiedSince && <span className="flex items-center gap-1 text-xs text-ink-soft"><Clock className="h-3 w-3" /> {elapsed((Date.now() - new Date(t.occupiedSince).getTime()) / 1000)}</span>}
                  <div className="mt-auto h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
                </>
              )}
            </button>
          ))}
        </div>
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
          {sel.orders.length === 0 ? <p className="text-sm text-ink-soft">No open orders on this table.</p> : (
            <div className="space-y-2">
              {sel.orders.map((o) => (
                <Card key={o.id} padded={false} className="flex items-center justify-between px-4 py-3">
                  <div><p className="font-semibold">{o.number}</p><p className="text-xs text-ink-soft">{o.waiterName} · {o.itemCount} items</p></div>
                  <div className="flex items-center gap-2"><b>{money(o.total)}</b>{can('orders.create') && <Button size="sm" onClick={() => nav(`/pos?order=${o.id}`)}>Open</Button>}</div>
                </Card>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
