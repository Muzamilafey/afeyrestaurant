import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bell, BellOff, Flame, AlertTriangle, Timer, Receipt } from 'lucide-react';
import { get, post } from '@/lib/api';
import { elapsed, time } from '@/lib/format';
import { Button, Empty, PageHeader, Pill, Skeleton, StatusPill, Tabs, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { onSocket } from '@/lib/socket';
import { useAuth } from '@/auth/AuthContext';
import { SoldOutDialog } from '@/components/SoldOutDialog';

interface Ticket { _id: string; orderNumber: string; tableNumber?: string; orderType: string; waiterName?: string; priority: boolean; status: string; completedVia?: 'station' | 'payment'; createdAt: string; ageSeconds: number; items: Array<{ lineId: string; name: string; qty: number; modifiers: string[]; notes?: string; status: string; ageRestricted?: boolean }> }
const NEXT: Record<string, { status: string; label: string }> = { pending: { status: 'accepted', label: 'Accept' }, accepted: { status: 'preparing', label: 'Start' }, preparing: { status: 'ready', label: 'Ready' }, ready: { status: 'completed', label: 'Served' } };

/** A short two-tone chime generated with WebAudio (no audio files to load). */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.3);
    });
  } catch {
    /* audio unavailable */
  }
}

export default function StationPage({ station }: { station: 'kitchen' | 'bar' }) {
  const { can, branch } = useAuth();
  const { handleError } = useFeedback();
  const qc = useQueryClient();
  const [view, setView] = useState<'active' | 'recent'>('active');
  const [soldOut, setSoldOut] = useState(false);
  const [sound, setSound] = useState(() => localStorage.getItem(`chili.sound.${station}`) !== 'off');
  const [now, setNow] = useState(Date.now());
  const { data, isLoading, dataUpdatedAt } = useQuery<{ delayMinutes: number; tickets: Ticket[] }>({ queryKey: ['tickets', station, view, branch?.id], queryFn: () => get(`/stations/${station}/tickets`, { include: view }), refetchInterval: 20_000 });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => onSocket('ticket.created', () => sound && chime()), [sound]);
  useEffect(() => localStorage.setItem(`chili.sound.${station}`, sound ? 'on' : 'off'), [sound, station]);

  const advance = (t: Ticket, status: string) => post(`/stations/tickets/${t._id}/status`, { status }).then(() => qc.invalidateQueries({ queryKey: ['tickets', station] })).catch(handleError);
  const canUpdate = can(station === 'bar' ? 'bar.update' : 'kitchen.update');
  const delay = (data?.delayMinutes ?? 15) * 60;
  // Server-computed age at fetch time plus local time elapsed since, so terminal clock skew does not matter.
  const age = (t: Ticket) => t.ageSeconds + (dataUpdatedAt > 0 ? Math.max(0, now - dataUpdatedAt) / 1000 : 0);
  const tickets = data?.tickets ?? [];
  const delayed = tickets.filter((t) => age(t) > delay && t.status !== 'ready').length;

  return (
    <div>
      <PageHeader
        title={station === 'kitchen' ? 'Kitchen display' : 'Bar display'}
        subtitle={`${tickets.length} ${view === 'active' ? 'active' : 'recent'} tickets${delayed ? ` · ${delayed} delayed` : ''}`}
        actions={<><Button variant="secondary" icon={<Ban className="h-4 w-4" />} onClick={() => setSoldOut(true)}>Sold out items</Button><Button variant="secondary" icon={sound ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />} onClick={() => { setSound(!sound); if (!sound) chime(); }}>{sound ? 'Sound on' : 'Sound off'}</Button></>}
      />
      <Tabs tabs={[{ id: 'active', label: 'Active' }, { id: 'recent', label: 'Completed' }]} value={view} onChange={setView} />
      {isLoading ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-60" />)}</div> : tickets.length === 0 ? <Empty title="No tickets" hint={view === 'active' ? 'New orders appear here instantly.' : undefined} /> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {tickets.map((t) => {
            const a = age(t);
            const late = a > delay && !['ready', 'completed', 'cancelled'].includes(t.status);
            const next = NEXT[t.status];
            return (
              <article key={t._id} className={cx('flex flex-col rounded-2xl border-2 bg-card shadow-soft', late ? 'border-danger' : t.priority ? 'border-warn' : t.status === 'ready' ? 'border-brand' : 'border-line')}>
                <header className={cx('flex items-center justify-between rounded-t-2xl px-4 py-3', late ? 'bg-danger-pale' : 'bg-page')}>
                  <div>
                    <p className="text-lg font-bold">{t.tableNumber ? `Table ${t.tableNumber}` : t.orderType.replace('_', ' ')}</p>
                    <p className="text-xs text-ink-soft">{t.orderNumber} · {t.waiterName} · {time(t.createdAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={cx('flex items-center gap-1 text-sm font-bold', late && 'text-danger')}><Timer className="h-4 w-4" /> {elapsed(a)}</span>
                    <StatusPill status={t.status} />
                  </div>
                </header>
                <div className="flex flex-wrap gap-1 px-4 pt-2">
                  {t.priority && <Pill color="yellow"><Flame className="h-3 w-3" /> Priority</Pill>}
                  {late && <Pill color="red"><AlertTriangle className="h-3 w-3" /> Delayed</Pill>}
                  {t.completedVia === 'payment' && <Pill color="green"><Receipt className="h-3 w-3" /> Paid — cleared automatically</Pill>}
                </div>
                <ul className="flex-1 space-y-2 px-4 py-3">
                  {t.items.map((i) => (
                    <li key={i.lineId} className={cx(i.status === 'cancelled' && 'text-ink-soft line-through')}>
                      <p className="font-semibold"><span className="mr-2 inline-block min-w-[28px] rounded-lg bg-ink px-1.5 text-center text-card">{i.qty}</span>{i.name}{i.ageRestricted && <span className="ml-1 text-xs text-ink-soft">(18+)</span>}</p>
                      {i.modifiers.length > 0 && <p className="ml-9 text-sm text-ink-soft">{i.modifiers.join(' · ')}</p>}
                      {i.notes && <p className="ml-9 text-sm font-semibold text-warn-ink">⚠ {i.notes}</p>}
                    </li>
                  ))}
                </ul>
                {view === 'active' && next && canUpdate && (
                  <div className="flex gap-2 border-t border-line p-3">
                    {t.status === 'pending' && <Button variant="secondary" className="flex-1" onClick={() => advance(t, 'preparing')}>Start now</Button>}
                    <Button size="lg" className="flex-1" onClick={() => advance(t, next.status)}>{next.label}</Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {soldOut && <SoldOutDialog station={station} onClose={() => setSoldOut(false)} />}
    </div>
  );
}
