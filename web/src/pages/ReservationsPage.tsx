import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CalendarPlus, Users, LayoutList, GanttChart } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime, time } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, StatusPill, Textarea, Select, Toggle, Tabs, cx, Skeleton } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface R { _id: string; code: string; customerName: string; phone?: string; partySize: number; startsAt: string; durationMinutes?: number; status: string; specialRequests?: string; tableIds: string[]; source: string }
interface TablesResp { areas: Array<{ _id: string; name: string }>; tables: Array<{ _id: string; number: string; capacity: number; areaId?: string }> }
interface FormValues { customerName: string; phone: string; email: string; partySize: number; date: string; time: string; durationMinutes: number; tableId: string; specialRequests: string; notify: boolean; source: string }

const HOUR_W = 96; // px per hour on the timeline
const BLOCK: Record<string, string> = { confirmed: 'bg-brand-pale border-brand/40 text-brand-dark', pending: 'bg-info-pale border-info/40 text-info', seated: 'bg-warn-pale border-warn/60 text-warn-ink', completed: 'bg-page border-line text-ink-soft', no_show: 'bg-danger-pale border-danger/40 text-danger' };

export default function ReservationsPage() {
  const { can, branch } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<'timeline' | 'list'>('timeline');
  const [area, setArea] = useState('all');
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<R | null>(null);
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(from.getTime() + (view === 'list' ? 7 : 1) * 86400_000);
  const { data, isLoading } = useQuery<R[]>({ queryKey: ['reservations', view, day], queryFn: () => get('/crm/reservations', { from: from.toISOString(), to: to.toISOString() }) });
  const { data: tables } = useQuery<TablesResp>({ queryKey: ['tables'], queryFn: () => get('/tables') });
  const form = useForm<FormValues>({ defaultValues: { partySize: 2, date: day, time: '19:00', durationMinutes: 90, notify: true, source: 'phone' } });
  const setStatus = (r: R, status: string) => post(`/crm/reservations/${r._id}/status`, { status }).then(() => { qc.invalidateQueries({ queryKey: ['reservations'] }); qc.invalidateQueries({ queryKey: ['tables'] }); setDetail(null); toast(`Reservation ${status.replace('_', ' ')}`); }).catch(handleError);

  const openNew = (preset: Partial<FormValues> = {}) => {
    form.reset({ partySize: 2, date: day, time: '19:00', durationMinutes: 90, notify: true, source: 'phone', customerName: '', phone: '', email: '', specialRequests: '', tableId: '', ...preset });
    setOpen(true);
  };
  const submit = form.handleSubmit(async (v) => {
    try {
      await post('/crm/reservations', { customerName: v.customerName, phone: v.phone || undefined, email: v.email || undefined, partySize: Number(v.partySize), startsAt: new Date(`${v.date}T${v.time}:00`).toISOString(), durationMinutes: Number(v.durationMinutes), tableIds: v.tableId ? [v.tableId] : undefined, specialRequests: v.specialRequests || undefined, notify: v.notify, source: v.source });
      toast(v.notify ? 'Reservation created — confirmation queued' : 'Reservation created');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['reservations'] });
    } catch (e) {
      handleError(e);
    }
  });

  // Timeline spans opening→closing hours (defaults 10:00–24:00), extended to fit any booking.
  const [startH, endH] = useMemo(() => {
    const open = parseInt((branch?.settings?.openingTime as string | undefined)?.slice(0, 2) ?? '10', 10);
    const close = parseInt((branch?.settings?.closingTime as string | undefined)?.slice(0, 2) ?? '24', 10) || 24;
    let s = Math.min(open, 10);
    let e = Math.max(close, 22);
    for (const r of data ?? []) {
      const d = new Date(r.startsAt);
      s = Math.min(s, d.getHours());
      e = Math.max(e, Math.ceil(d.getHours() + (d.getMinutes() + (r.durationMinutes ?? 90)) / 60));
    }
    return [s, Math.min(24, e)];
  }, [branch, data]);
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const rows = (tables?.tables ?? []).filter((t) => area === 'all' || t.areaId === area);
  const unassigned = (data ?? []).filter((r) => !r.tableIds.length && !['cancelled'].includes(r.status));
  const pos = (r: R) => {
    const d = new Date(r.startsAt);
    const left = (d.getHours() + d.getMinutes() / 60 - startH) * HOUR_W;
    return { left, width: Math.max(48, ((r.durationMinutes ?? 90) / 60) * HOUR_W - 4) };
  };
  const now = new Date();
  const nowX = day === now.toISOString().slice(0, 10) ? (now.getHours() + now.getMinutes() / 60 - startH) * HOUR_W : null;

  return (
    <div>
      <PageHeader title="Reservations" subtitle={view === 'timeline' ? new Date(`${day}T12:00:00`).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Next 7 days'} actions={<>
        <div className="flex rounded-xl border border-line bg-card p-1">
          <button onClick={() => setView('timeline')} className={cx('flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold', view === 'timeline' ? 'bg-brand text-white' : 'text-ink-soft')}><GanttChart className="h-4 w-4" /> Timeline</button>
          <button onClick={() => setView('list')} className={cx('flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold', view === 'list' ? 'bg-brand text-white' : 'text-ink-soft')}><LayoutList className="h-4 w-4" /> List</button>
        </div>
        <Select value={day === new Date().toISOString().slice(0, 10) ? 'today' : 'custom'} onChange={(e) => e.target.value === 'today' ? setDay(new Date().toISOString().slice(0, 10)) : e.target.value === 'tomorrow' && setDay(new Date(Date.now() + 86400_000).toISOString().slice(0, 10))} className="w-32"><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="custom" hidden>Custom</option></Select>
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-40" />
        {can('reservations.manage') && <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => openNew()}>New reservation</Button>}
      </>} />

      {view === 'timeline' ? (
        <>
          {(tables?.areas.length ?? 0) > 0 && <Tabs tabs={[{ id: 'all', label: 'All areas' }, ...tables!.areas.map((a) => ({ id: a._id, label: a.name }))]} value={area} onChange={setArea} />}
          <Card padded={false} className="overflow-hidden">
            {isLoading || !tables ? <Skeleton className="m-5 h-72" /> : (
              <div className="scroll-thin overflow-x-auto">
                <div style={{ width: 88 + hours.length * HOUR_W }} className="relative">
                  <div className="sticky top-0 z-10 flex border-b border-line bg-card">
                    <div className="w-[88px] shrink-0" />
                    {hours.map((h) => <div key={h} style={{ width: HOUR_W }} className="shrink-0 border-l border-line/60 py-2 pl-2 text-xs text-ink-soft">{String(h % 24).padStart(2, '0')}:00</div>)}
                  </div>
                  {[...rows.map((t) => ({ key: t._id, label: t.number, capacity: t.capacity, items: (data ?? []).filter((r) => r.tableIds.includes(t._id) && r.status !== 'cancelled') })), ...(unassigned.length ? [{ key: 'none', label: 'No table', capacity: 0, items: unassigned }] : [])].map((row) => (
                    <div key={row.key} className="relative flex h-[72px] border-b border-line/70">
                      <div className="flex w-[88px] shrink-0 flex-col justify-center border-r border-line px-3"><span className="font-bold">{row.label}</span>{row.capacity > 0 && <span className="flex items-center gap-1 text-[11px] text-ink-soft"><Users className="h-3 w-3" />{row.capacity}</span>}</div>
                      <div className="relative flex-1">
                        {hours.map((h) => (
                          <button key={h} aria-label={`Book ${row.label} at ${h}:00`} disabled={!can('reservations.manage') || row.key === 'none'} onClick={() => openNew({ tableId: row.key, time: `${String(h).padStart(2, '0')}:00`, partySize: Math.min(row.capacity || 2, 2) })} style={{ left: (h - startH) * HOUR_W, width: HOUR_W }} className="absolute inset-y-0 border-l border-dashed border-line/60 hover:bg-brand-50" />
                        ))}
                        {row.items.map((r) => {
                          const p = pos(r);
                          return (
                            <button key={r._id} onClick={() => setDetail(r)} style={{ left: p.left + 2, width: p.width }} className={cx('absolute inset-y-2 z-[1] flex flex-col justify-between overflow-hidden rounded-xl border px-2.5 py-1.5 text-left text-xs shadow-soft', BLOCK[r.status] ?? BLOCK.confirmed)}>
                              <span className="truncate font-semibold">{r.customerName}</span>
                              <span className="flex items-center gap-1 opacity-80"><Users className="h-3 w-3" />{r.partySize} · {time(r.startsAt)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {nowX !== null && nowX > 0 && nowX < hours.length * HOUR_W && <div className="pointer-events-none absolute bottom-0 top-0 z-[2] w-0.5 bg-danger/70" style={{ left: 88 + nowX }} />}
                </div>
              </div>
            )}
          </Card>
          <p className="mt-2 text-xs text-ink-soft">Tap an empty slot to book that table at that time. Tap a booking to seat, complete or cancel it.</p>
        </>
      ) : (
        <Card padded>
          <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} onRowClick={setDetail} columns={[
            { key: 'when', header: 'When', render: (r) => dateTime(r.startsAt) },
            { key: 'guest', header: 'Guest', render: (r) => <div><p className="font-semibold">{r.customerName}</p><p className="text-xs text-ink-soft">{r.phone}</p></div> },
            { key: 'party', header: 'Party', render: (r) => r.partySize },
            { key: 'table', header: 'Table', render: (r) => r.tableIds.map((id) => tables?.tables.find((t) => t._id === id)?.number).join(', ') || '—' },
            { key: 'code', header: 'Ref', render: (r) => r.code },
            { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 'notes', header: 'Requests', render: (r) => <span className="text-xs">{r.specialRequests}</span> },
          ]} />
        </Card>
      )}

      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.customerName} footer={can('reservations.manage') && (
          <>
            {['confirmed', 'pending'].includes(detail.status) && <><Button variant="ghost" onClick={() => setStatus(detail, 'cancelled')}>Cancel booking</Button><Button variant="secondary" onClick={() => setStatus(detail, 'no_show')}>No-show</Button><Button onClick={() => setStatus(detail, 'seated')}>Seat now</Button></>}
            {detail.status === 'seated' && <Button onClick={() => setStatus(detail, 'completed')}>Complete</Button>}
          </>
        )}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="label">When</dt><dd>{dateTime(detail.startsAt)} ({detail.durationMinutes ?? 90} min)</dd></div>
            <div><dt className="label">Party</dt><dd>{detail.partySize} guests</dd></div>
            <div><dt className="label">Table</dt><dd>{detail.tableIds.map((id) => tables?.tables.find((t) => t._id === id)?.number).join(', ') || 'Not assigned'}</dd></div>
            <div><dt className="label">Status</dt><dd><StatusPill status={detail.status} /></dd></div>
            <div><dt className="label">Phone</dt><dd>{detail.phone ?? '—'}</dd></div>
            <div><dt className="label">Reference</dt><dd>{detail.code}</dd></div>
            {detail.specialRequests && <div className="col-span-2"><dt className="label">Requests</dt><dd>{detail.specialRequests}</dd></div>}
          </dl>
        </Modal>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New reservation" footer={<Button onClick={submit} loading={form.formState.isSubmitting}>Save</Button>}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Guest name"><Input {...form.register('customerName', { required: true })} /></Field>
          <Field label="Phone"><Input inputMode="tel" {...form.register('phone')} /></Field>
          <Field label="Email (optional)"><Input type="email" {...form.register('email')} /></Field>
          <Field label="Party size"><Input type="number" min={1} {...form.register('partySize')} /></Field>
          <Field label="Date"><Input type="date" {...form.register('date')} /></Field>
          <Field label="Time"><Input type="time" {...form.register('time')} /></Field>
          <Field label="Duration"><Select {...form.register('durationMinutes')}><option value={60}>1 hour</option><option value={90}>1½ hours</option><option value={120}>2 hours</option><option value={180}>3 hours</option></Select></Field>
          <Field label="Table"><Select {...form.register('tableId')}><option value="">Assign later</option>{tables?.tables.map((t) => <option key={t._id} value={t._id}>T-{t.number} ({t.capacity})</option>)}</Select></Field>
          <Field label="Source"><Select {...form.register('source')}><option value="phone">Phone</option><option value="walk_in">Walk-in</option><option value="online">Online</option><option value="staff">Staff</option></Select></Field>
          <Field label="Special requests" className="sm:col-span-2"><Textarea {...form.register('specialRequests')} /></Field>
          <div className="sm:col-span-2"><Toggle checked={form.watch('notify')} onChange={(v) => form.setValue('notify', v)} label="Send SMS/email confirmation" /></div>
        </form>
      </Modal>
    </div>
  );
}
