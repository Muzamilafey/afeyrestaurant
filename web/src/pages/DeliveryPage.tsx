import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { money, time } from '@/lib/format';
import { Button, Card, DataTable, PageHeader, Select, StatusPill } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface O { _id: string; number: string; customerName?: string; customerPhone?: string; createdAt: string; totals: { total: number }; status: string; paymentStatus: string; items: Array<{ status: string; voided: boolean }>; delivery?: { address?: string; status?: string; riderId?: string; riderName?: string; trackingCode?: string } }

export default function DeliveryPage() {
  const { can, session } = useAuth();
  const { handleError } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<O[]>({ queryKey: ['orders', 'delivery'], queryFn: () => get('/crm/delivery'), refetchInterval: 20_000 });
  const { data: riders } = useQuery<Array<{ _id: string; name: string }>>({ queryKey: ['riders'], queryFn: () => get('/crm/riders') });
  const update = (o: O, body: Record<string, unknown>) => post(`/crm/delivery/${o._id}`, body).then(() => qc.invalidateQueries({ queryKey: ['orders', 'delivery'] })).catch(handleError);
  return (
    <div>
      <PageHeader title="Delivery" subtitle="Active delivery and online orders" />
      <Card>
        <DataTable rows={data} loading={isLoading} rowKey={(o) => o._id} columns={[
          { key: 'n', header: 'Order', render: (o) => <div><p className="font-semibold">{o.number}</p><p className="text-xs text-ink-soft">{time(o.createdAt)}</p></div> },
          { key: 'c', header: 'Customer', render: (o) => <div><p>{o.customerName}</p><p className="text-xs text-ink-soft">{o.customerPhone}</p></div> },
          { key: 'a', header: 'Address', render: (o) => <span className="text-xs">{o.delivery?.address}</span> },
          { key: 'k', header: 'Kitchen', render: (o) => { const it = o.items.filter((i) => !i.voided); return it.every((i) => ['ready', 'served'].includes(i.status)) ? <StatusPill status="ready" /> : <StatusPill status="preparing" />; } },
          { key: 't', header: 'Total', render: (o) => <div>{money(o.totals.total)} <StatusPill status={o.paymentStatus} /></div> },
          { key: 'r', header: 'Rider', render: (o) => can('delivery.manage') ? <Select value={o.delivery?.riderId ?? ''} onChange={(e) => update(o, { riderId: e.target.value })} className="w-36"><option value="">Assign…</option>{riders?.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}</Select> : o.delivery?.riderName },
          { key: 's', header: 'Status', render: (o) => <StatusPill status={o.delivery?.status} /> },
          { key: 'x', header: '', render: (o) => can('delivery.manage') && <div className="flex gap-1">{o.delivery?.status === 'assigned' && <Button size="sm" onClick={() => update(o, { status: 'picked_up' })}>Picked up</Button>}{o.delivery?.status === 'picked_up' && <Button size="sm" onClick={() => update(o, { status: 'delivered' })}>Delivered</Button>}{o.delivery?.trackingCode && <a className="btn-ghost !min-h-[32px] !text-xs" target="_blank" rel="noreferrer" href={`/track/${session?.tenant?.slug}/${o.delivery.trackingCode}`}>Track</a>}</div> },
        ]} />
      </Card>
    </div>
  );
}
