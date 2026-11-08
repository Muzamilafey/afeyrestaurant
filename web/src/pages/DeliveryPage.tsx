import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, CheckCircle2, Pencil, Plus } from 'lucide-react';
import { get, patch, post } from '@/lib/api';
import { money, time } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Toggle } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import type { Rider } from '@/pages/pos/AssignRiderDialog';

interface O { _id: string; number: string; customerName?: string; customerPhone?: string; createdAt: string; totals: { total: number }; status: string; paymentStatus: string; items: Array<{ status: string; voided: boolean }>; delivery?: { address?: string; status?: string; riderId?: string; riderName?: string; trackingCode?: string; deliveredAt?: string; deliveredBy?: string } }
type TabId = 'active' | 'done' | 'riders';

export default function DeliveryPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (['active', 'done', 'riders'].includes(params.get('tab') ?? '') ? params.get('tab') : 'active') as TabId;
  const setTab = (t: TabId) => setParams(t === 'active' ? {} : { tab: t }, { replace: true });
  return (
    <div>
      <PageHeader title="Delivery" subtitle="Delivery orders, riders and drop-offs" />
      <Tabs<TabId> tabs={[{ id: 'active', label: 'On the way' }, { id: 'done', label: 'Delivered today' }, { id: 'riders', label: 'Riders', hidden: !can('delivery.view', 'delivery.manage') }]} value={tab} onChange={setTab} />
      {tab === 'riders' ? <Riders /> : <Deliveries done={tab === 'done'} />}
    </div>
  );
}

function Deliveries({ done }: { done: boolean }) {
  const { can } = useAuth();
  const { handleError, toast, confirm } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<O[]>({ queryKey: ['orders', 'delivery', done], queryFn: () => get('/crm/delivery', { done: done ? '1' : undefined }), refetchInterval: 20_000 });
  const { data: riders } = useQuery<Rider[]>({ queryKey: ['riders'], queryFn: () => get('/crm/riders') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['orders', 'delivery'] }); qc.invalidateQueries({ queryKey: ['riders'] }); };
  const update = (o: O, body: Record<string, unknown>) => post(`/crm/delivery/${o._id}`, body).then(refresh).catch(handleError);
  const delivered = async (o: O) => {
    const c = await confirm({ title: `Mark ${o.number} delivered?`, message: <>Confirm that {o.customerName ?? 'the customer'} received the order{o.delivery?.riderName ? <> from <b>{o.delivery.riderName}</b></> : null}. Your name is recorded.</>, confirmLabel: 'Delivered' });
    if (!c.ok) return;
    post(`/crm/delivery/${o._id}/delivered`, {}).then(() => { refresh(); toast(`${o.number} delivered`); }).catch(handleError);
  };
  const active = (riders ?? []).filter((r) => r.active);
  return (
    <Card>
      <DataTable rows={data} loading={isLoading} rowKey={(o) => o._id} empty={done ? 'Nothing delivered in the last 24 hours' : 'No deliveries on the way'} columns={[
        { key: 'n', header: 'Order', render: (o) => <div><p className="font-semibold">{o.number}</p><p className="text-xs text-ink-soft">{time(o.createdAt)}</p></div> },
        { key: 'c', header: 'Customer', render: (o) => <div><p>{o.customerName ?? '—'}</p>{o.customerPhone && <a className="text-xs text-ink-soft underline" href={`tel:${o.customerPhone}`}>{o.customerPhone}</a>}</div> },
        { key: 'a', header: 'Address', render: (o) => <span className="text-xs">{o.delivery?.address}</span> },
        ...(done ? [] : [{ key: 'k', header: 'Kitchen', render: (o: O) => { const it = o.items.filter((i) => !i.voided); return it.every((i) => ['ready', 'served'].includes(i.status)) ? <StatusPill status="ready" /> : <StatusPill status="preparing" />; } }]),
        { key: 't', header: 'Total', render: (o) => <div>{money(o.totals.total)} <StatusPill status={o.paymentStatus} /></div> },
        { key: 'r', header: 'Rider', render: (o) => (!done && can('delivery.manage')
          ? <Select value={o.delivery?.riderId ?? ''} onChange={(e) => e.target.value && update(o, { riderId: e.target.value })} className="w-40" aria-label="Rider"><option value="">Assign…</option>{active.map((r) => <option key={r._id} value={r._id}>{r.name}{r.activeDeliveries ? ` (${r.activeDeliveries})` : ''}</option>)}</Select>
          : <span className="inline-flex items-center gap-1"><Bike className="h-3.5 w-3.5 text-ink-soft" />{o.delivery?.riderName ?? '—'}</span>) },
        { key: 's', header: 'Status', render: (o) => (done ? <div className="text-xs"><StatusPill status="delivered" /><p className="mt-1 text-ink-soft">{o.delivery?.deliveredAt ? time(o.delivery.deliveredAt) : ''}{o.delivery?.deliveredBy ? ` · by ${o.delivery.deliveredBy}` : ''}</p></div> : <StatusPill status={o.delivery?.status} />) },
        { key: 'x', header: '', render: (o) => !done && (
          <div className="flex flex-wrap gap-1">
            {can('delivery.manage') && o.delivery?.status === 'assigned' && <Button size="sm" variant="secondary" onClick={() => update(o, { status: 'picked_up' })}>Picked up</Button>}
            <Button size="sm" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => delivered(o)}>Mark delivered</Button>
            {o.delivery?.trackingCode && <a className="btn-ghost !min-h-[32px] !text-xs" target="_blank" rel="noreferrer" href={`/track/${o.delivery.trackingCode}`}>Track</a>}
          </div>
        ) },
      ]} />
    </Card>
  );
}

interface RiderForm { _id?: string; name: string; phone: string; vehicle: string; plate: string; notes: string; active: boolean }

/** Register and manage the delivery riders (agents) of this branch. */
function Riders() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Rider[]>({ queryKey: ['riders'], queryFn: () => get('/crm/riders') });
  const [f, setF] = useState<RiderForm | null>(null);
  const manage = can('delivery.manage');
  const save = () => {
    if (!f) return;
    const body = { name: f.name.trim(), phone: f.phone.trim() || undefined, vehicle: f.vehicle || undefined, plate: f.plate.trim().toUpperCase() || undefined, notes: f.notes.trim() || undefined, active: f.active };
    (f._id ? patch(`/crm/riders/${f._id}`, body) : post('/crm/riders', body))
      .then(() => { qc.invalidateQueries({ queryKey: ['riders'] }); toast(f._id ? 'Rider updated' : `${body.name} registered`); setF(null); })
      .catch(handleError);
  };
  return (
    <Card title="Delivery riders" actions={manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ name: '', phone: '', vehicle: 'Motorbike', plate: '', notes: '', active: true })}>Register rider</Button>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} empty="No riders yet — register the people who deliver your orders" columns={[
        { key: 'n', header: 'Rider', render: (r) => <div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-pale text-brand-dark"><Bike className="h-4 w-4" /></span><div><p className="font-semibold">{r.name}</p>{r.phone && <a className="text-xs text-ink-soft underline" href={`tel:${r.phone}`}>{r.phone}</a>}</div></div> },
        { key: 'v', header: 'Vehicle', render: (r) => [r.vehicle, r.plate].filter(Boolean).join(' · ') || '—' },
        { key: 'l', header: 'Now', render: (r) => (r.activeDeliveries ? <Pill color="yellow">{r.activeDeliveries} on the way</Pill> : <Pill color="green">Available</Pill>) },
        { key: 's', header: 'Status', render: (r) => (r.active ? <Pill color="green">Active</Pill> : <Pill color="gray">Inactive</Pill>) },
        { key: 'x', header: '', render: (r) => manage && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setF({ _id: r._id, name: r.name, phone: r.phone ?? '', vehicle: r.vehicle ?? '', plate: r.plate ?? '', notes: (r as Rider & { notes?: string }).notes ?? '', active: r.active })}>Edit</Button> },
      ]} />
      {f && (
        <Modal open onClose={() => setF(null)} title={f._id ? `Edit ${f.name}` : 'Register a delivery rider'} footer={<Button disabled={f.name.trim().length < 2} onClick={save}>{f._id ? 'Save' : 'Register rider'}</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" className="sm:col-span-2"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07XX XXX XXX" /></Field>
            <Field label="Vehicle"><Select value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })}><option value="">—</option><option>Motorbike</option><option>Bicycle</option><option>Car</option><option>Tuk-tuk</option><option>On foot</option></Select></Field>
            <Field label="Number plate"><Input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="KMXX 123A" /></Field>
            <Field label="Notes (ID number, area)"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            {f._id && <div className="sm:col-span-2"><Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active (can be assigned deliveries)" /></div>}
          </div>
        </Modal>
      )}
    </Card>
  );
}
