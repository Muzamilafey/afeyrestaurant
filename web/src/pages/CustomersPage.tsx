import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Star, Lock } from 'lucide-react';
import { get, post, patch } from '@/lib/api';
import { date, dateTime, money, toCents } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, StatusPill, Tabs, Textarea, Toggle } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface C { _id: string; name: string; phone?: string; email?: string; visits: number; totalSpent: number; lastVisitAt?: string; consent?: { marketingSms: boolean; marketingEmail: boolean; birthdayOffers: boolean }; credit?: { approved: boolean; limit: number; balance: number }; birthday?: { month: number; day: number } }

export default function CustomersPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'customers' | 'coupons' | 'feedback'>('customers');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery<C[]>({ queryKey: ['customers', q], queryFn: () => get('/crm/customers', { q: q || undefined }) });
  return (
    <div>
      <PageHeader title="Customers" subtitle="Profiles, visit history, loyalty and communication preferences" actions={can('customers.manage') && <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>New customer</Button>} />
      <Tabs tabs={[{ id: 'customers', label: 'Customers' }, { id: 'coupons', label: 'Coupons', hidden: !can('loyalty.manage') }, { id: 'feedback', label: 'Feedback' }]} value={tab} onChange={setTab} />
      {tab === 'customers' && (
        <Card actions={<Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />} title="All customers">
          <DataTable rows={list.data} loading={list.isLoading} rowKey={(r) => r._id} onRowClick={(r) => setSel(r._id)} columns={[
            { key: 'n', header: 'Name', render: (r) => <b>{r.name}</b> },
            { key: 'p', header: 'Phone', render: (r) => r.phone ?? '—' },
            { key: 'v', header: 'Visits', render: (r) => r.visits },
            { key: 's', header: 'Spent', render: (r) => money(r.totalSpent) },
            { key: 'l', header: 'Last visit', render: (r) => date(r.lastVisitAt) },
            { key: 'm', header: 'Marketing', render: (r) => (r.consent?.marketingSms || r.consent?.marketingEmail ? <Pill color="green">Opted in</Pill> : <Pill>Opted out</Pill>) },
            { key: 'c', header: 'Credit', render: (r) => (r.credit?.approved ? `${money(r.credit.balance)} / ${money(r.credit.limit)}` : '—') },
          ]} />
        </Card>
      )}
      {tab === 'coupons' && <Coupons />}
      {tab === 'feedback' && <FeedbackList />}
      {sel && <CustomerDetail id={sel} onClose={() => setSel(null)} />}
      {creating && <CustomerForm onClose={() => setCreating(false)} />}
    </div>
  );
}

function CustomerForm({ onClose }: { onClose: () => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', phone: '', email: '', marketingSms: false, marketingEmail: false, birthdayOffers: false });
  return (
    <Modal open onClose={onClose} title="New customer" footer={<Button onClick={() => post('/crm/customers', { name: f.name, phone: f.phone || undefined, email: f.email || undefined, consent: { marketingSms: f.marketingSms, marketingEmail: f.marketingEmail, birthdayOffers: f.birthdayOffers } }).then(() => { qc.invalidateQueries({ queryKey: ['customers'] }); toast('Customer added'); onClose(); }).catch(handleError)}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email (optional)"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <p className="label">Consent (ask the customer)</p>
        <div className="flex flex-col gap-2">
          <Toggle checked={f.marketingSms} onChange={(v) => setF({ ...f, marketingSms: v })} label="Promotional SMS" />
          <Toggle checked={f.marketingEmail} onChange={(v) => setF({ ...f, marketingEmail: v })} label="Promotional email" />
          <Toggle checked={f.birthdayOffers} onChange={(v) => setF({ ...f, birthdayOffers: v })} label="Birthday offers" />
        </div>
      </div>
    </Modal>
  );
}

function CustomerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const { handleError, toast, confirm , prompt } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<{ customer: C; orders: Array<{ _id: string; number: string; totals: { total: number }; createdAt: string; status: string }>; loyalty?: { points: number; lifetimePoints: number }; notes: Array<{ _id: string; note: string; createdAt: string }> | null; reservations: Array<{ _id: string; startsAt: string; partySize: number; status: string }> }>({ queryKey: ['customer', id], queryFn: () => get(`/crm/customers/${id}`) });
  const [note, setNote] = useState('');
  if (!data) return null;
  const c = data.customer;
  const setConsent = (k: 'marketingSms' | 'marketingEmail' | 'birthdayOffers', v: boolean) => patch(`/crm/customers/${id}`, { consent: { [k]: v } }).then(() => qc.invalidateQueries({ queryKey: ['customer', id] })).catch(handleError);
  return (
    <Modal open onClose={onClose} title={c.name} size="lg">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p>{c.phone} {c.email && `· ${c.email}`}</p>
          <p>Visits <b>{c.visits}</b> · Spent <b>{money(c.totalSpent)}</b></p>
          <p className="flex items-center gap-1"><Star className="h-4 w-4 text-warn" /> Loyalty <b>{data.loyalty?.points ?? 0}</b> pts (lifetime {data.loyalty?.lifetimePoints ?? 0})</p>
          <div className="space-y-2 rounded-xl bg-page p-3">
            <p className="label">Communication preferences</p>
            <Toggle checked={!!c.consent?.marketingSms} onChange={(v) => setConsent('marketingSms', v)} label="Promotional SMS" disabled={!can('customers.manage')} />
            <Toggle checked={!!c.consent?.marketingEmail} onChange={(v) => setConsent('marketingEmail', v)} label="Promotional email" disabled={!can('customers.manage')} />
            <Toggle checked={!!c.consent?.birthdayOffers} onChange={(v) => setConsent('birthdayOffers', v)} label="Birthday offers" disabled={!can('customers.manage')} />
            <p className="text-xs text-ink-soft">Transactional messages (receipts, reservations) are always sent.</p>
          </div>
          {can('payments.credit_sale') && (
            <Button size="sm" variant="secondary" onClick={async () => { const l = await prompt({ title: 'Credit account', label: 'Credit limit (KSh)', hint: 'Enter 0 to disable the credit account.', inputMode: 'decimal', defaultValue: String((c.credit?.limit ?? 0) / 100), confirmLabel: 'Save limit' }); if (l !== null && !Number.isNaN(Number(l))) post(`/crm/customers/${id}/credit`, { approved: Number(l) > 0, limit: toCents(l) }).then(() => { qc.invalidateQueries({ queryKey: ['customer', id] }); toast('Credit updated'); }).catch(handleError); }}>
              Credit account: {c.credit?.approved ? `${money(c.credit.balance)} owed of ${money(c.credit.limit)}` : 'not approved'}
            </Button>
          )}
          {can('customers.manage') && <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { const r = await confirm({ title: 'Anonymise customer?', message: 'Removes personal data (right to erasure). Sales records are kept without the name/phone.', reason: true, danger: true, confirmLabel: 'Anonymise' }); if (r.ok) post(`/crm/customers/${id}/anonymise`, { reason: r.reason }).then(() => { qc.invalidateQueries({ queryKey: ['customers'] }); onClose(); toast('Customer anonymised'); }).catch(handleError); }}>Anonymise (erasure request)</Button>}
        </div>
        <div className="space-y-3">
          <div>
            <p className="label">Recent orders</p>
            <div className="max-h-48 space-y-1 overflow-y-auto">{data.orders.map((o) => <div key={o._id} className="flex justify-between rounded-lg bg-page px-3 py-1.5 text-sm"><span>{o.number} · {date(o.createdAt)}</span><span>{money(o.totals.total)} <StatusPill status={o.status} /></span></div>)}</div>
          </div>
          {data.notes !== null ? (
            <div>
              <p className="label flex items-center gap-1"><Lock className="h-3 w-3" /> Restricted notes</p>
              {data.notes.map((n) => <p key={n._id} className="mb-1 rounded-lg bg-warn-pale px-3 py-1.5 text-sm">{n.note} <span className="text-xs text-ink-soft">{dateTime(n.createdAt)}</span></p>)}
              <div className="flex gap-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[40px]" /><Button size="sm" disabled={!note} onClick={() => post(`/crm/customers/${id}/notes`, { note }).then(() => { setNote(''); qc.invalidateQueries({ queryKey: ['customer', id] }); }).catch(handleError)}>Add</Button></div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function Coupons() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; code: string; type: string; value: number; uses: number; maxUses?: number; validTo?: string; active: boolean }>>({ queryKey: ['coupons'], queryFn: () => get('/crm/coupons') });
  const [f, setF] = useState({ code: '', type: 'percent', value: '10', maxUses: '' });
  return (
    <Card title="Coupons" actions={<div className="flex gap-2"><Input placeholder="CODE" className="w-28" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /><select className="input w-28" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="percent">%</option><option value="amount">KSh</option></select><Input className="w-20" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /><Button size="sm" onClick={() => post('/crm/coupons', { code: f.code, type: f.type, value: f.type === 'amount' ? toCents(f.value) : Number(f.value), maxUses: f.maxUses ? Number(f.maxUses) : undefined }).then(() => { qc.invalidateQueries({ queryKey: ['coupons'] }); toast('Coupon created'); }).catch(handleError)}>Add</Button></div>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'c', header: 'Code', render: (r) => <b>{r.code}</b> }, { key: 'v', header: 'Value', render: (r) => (r.type === 'percent' ? `${r.value}%` : money(r.value)) }, { key: 'u', header: 'Uses', render: (r) => `${r.uses}${r.maxUses ? ` / ${r.maxUses}` : ''}` }, { key: 'a', header: 'Status', render: (r) => <StatusPill status={r.active ? 'active' : 'closed'} /> }]} />
    </Card>
  );
}

function FeedbackList() {
  const { data, isLoading } = useQuery<Array<{ _id: string; rating: number; comment?: string; createdAt: string }>>({ queryKey: ['feedback'], queryFn: () => get('/crm/feedback') });
  return <Card><DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'r', header: 'Rating', render: (r) => '★'.repeat(r.rating) }, { key: 'c', header: 'Comment', render: (r) => r.comment }, { key: 'd', header: 'Date', render: (r) => dateTime(r.createdAt) }]} /></Card>;
}
