import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CalendarPlus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, StatusPill, Textarea, Select, Toggle } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface R { _id: string; code: string; customerName: string; phone?: string; partySize: number; startsAt: string; status: string; specialRequests?: string; tableIds: string[]; source: string }

export default function ReservationsPage() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState(false);
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(from.getTime() + 7 * 86400_000);
  const { data, isLoading } = useQuery<R[]>({ queryKey: ['reservations', day], queryFn: () => get('/crm/reservations', { from: from.toISOString(), to: to.toISOString() }) });
  const { data: tables } = useQuery<{ tables: Array<{ _id: string; number: string; capacity: number }> }>({ queryKey: ['tables'], queryFn: () => get('/tables') });
  const form = useForm<{ customerName: string; phone: string; email: string; partySize: number; date: string; time: string; tableId: string; specialRequests: string; notify: boolean; source: string }>({ defaultValues: { partySize: 2, date: day, time: '19:00', notify: true, source: 'phone' } });
  const setStatus = (r: R, status: string) => post(`/crm/reservations/${r._id}/status`, { status }).then(() => { qc.invalidateQueries({ queryKey: ['reservations'] }); toast(`Reservation ${status}`); }).catch(handleError);

  const submit = form.handleSubmit(async (v) => {
    try {
      await post('/crm/reservations', { customerName: v.customerName, phone: v.phone || undefined, email: v.email || undefined, partySize: Number(v.partySize), startsAt: new Date(`${v.date}T${v.time}:00`).toISOString(), tableIds: v.tableId ? [v.tableId] : undefined, specialRequests: v.specialRequests || undefined, notify: v.notify, source: v.source });
      toast('Reservation created — confirmation queued');
      setOpen(false);
      form.reset();
      qc.invalidateQueries({ queryKey: ['reservations'] });
    } catch (e) {
      handleError(e);
    }
  });

  return (
    <div>
      <PageHeader title="Reservations" subtitle="Next 7 days" actions={<><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />{can('reservations.manage') && <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setOpen(true)}>New reservation</Button>}</>} />
      <Card padded>
        <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
          { key: 'when', header: 'When', render: (r) => dateTime(r.startsAt) },
          { key: 'guest', header: 'Guest', render: (r) => <div><p className="font-semibold">{r.customerName}</p><p className="text-xs text-ink-soft">{r.phone}</p></div> },
          { key: 'party', header: 'Party', render: (r) => r.partySize },
          { key: 'table', header: 'Table', render: (r) => r.tableIds.map((id) => tables?.tables.find((t) => t._id === id)?.number).join(', ') || '—' },
          { key: 'code', header: 'Ref', render: (r) => r.code },
          { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
          { key: 'notes', header: 'Requests', render: (r) => <span className="text-xs">{r.specialRequests}</span> },
          { key: 'act', header: '', render: (r) => can('reservations.manage') && ['confirmed', 'pending'].includes(r.status) ? <div className="flex gap-1"><Button size="sm" onClick={() => setStatus(r, 'seated')}>Seat</Button><Button size="sm" variant="secondary" onClick={() => setStatus(r, 'no_show')}>No-show</Button><Button size="sm" variant="ghost" onClick={() => setStatus(r, 'cancelled')}>Cancel</Button></div> : r.status === 'seated' ? <Button size="sm" variant="secondary" onClick={() => setStatus(r, 'completed')}>Complete</Button> : null },
        ]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New reservation" footer={<Button onClick={submit} loading={form.formState.isSubmitting}>Save</Button>}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Guest name"><Input {...form.register('customerName', { required: true })} /></Field>
          <Field label="Phone"><Input inputMode="tel" {...form.register('phone')} /></Field>
          <Field label="Email (optional)"><Input type="email" {...form.register('email')} /></Field>
          <Field label="Party size"><Input type="number" min={1} {...form.register('partySize')} /></Field>
          <Field label="Date"><Input type="date" {...form.register('date')} /></Field>
          <Field label="Time"><Input type="time" {...form.register('time')} /></Field>
          <Field label="Table"><Select {...form.register('tableId')}><option value="">Assign later</option>{tables?.tables.map((t) => <option key={t._id} value={t._id}>T-{t.number} ({t.capacity})</option>)}</Select></Field>
          <Field label="Source"><Select {...form.register('source')}><option value="phone">Phone</option><option value="walk_in">Walk-in</option><option value="online">Online</option><option value="staff">Staff</option></Select></Field>
          <Field label="Special requests" className="sm:col-span-2"><Textarea {...form.register('specialRequests')} /></Field>
          <div className="sm:col-span-2"><Toggle checked={form.watch('notify')} onChange={(v) => form.setValue('notify', v)} label="Send SMS/email confirmation" /></div>
        </form>
      </Modal>
    </div>
  );
}
