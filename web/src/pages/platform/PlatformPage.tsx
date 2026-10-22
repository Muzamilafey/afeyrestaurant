import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Activity, DatabaseBackup, AlertTriangle } from 'lucide-react';
import { get, post, put } from '@/lib/api';
import { dateTime, money, titleCase, toCents, fromCents } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, Stat, StatusPill, Tabs, Skeleton } from '@/components/ui';
import { useFeedback } from '@/components/feedback';

interface Tenant { _id: string; name: string; slug: string; status: string; createdAt: string; branches: number; subscription: null | { status: string; plan?: string; currentPeriodEnd?: string; trialEndsAt?: string; interval: string } }
interface Plan { _id: string; code: string; name: string; description?: string; priceMonthly: number; priceAnnual: number; trialDays: number; limits: Record<string, number>; features: string[]; active: boolean }
const FEATURES = ['pos', 'tables', 'kds', 'bar', 'inventory', 'recipes', 'procurement', 'mpesa', 'sms', 'email', 'reservations', 'delivery', 'loyalty', 'attendance', 'biometrics', 'reports_advanced', 'multi_branch', 'offline', 'api_access'];

export default function PlatformPage() {
  const [tab, setTab] = useState<'overview' | 'tenants' | 'plans' | 'health' | 'audit'>('overview');
  return (
    <div>
      <PageHeader title="Platform owner" subtitle="Tenants, subscriptions and system health. Tenant business data is not shown here." />
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'tenants', label: 'Tenants' }, { id: 'plans', label: 'Plans' }, { id: 'health', label: 'System health' }, { id: 'audit', label: 'Audit' }]} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'tenants' && <Tenants />}
      {tab === 'plans' && <Plans />}
      {tab === 'health' && <Health />}
      {tab === 'audit' && <PlatformAudit />}
    </div>
  );
}

function Overview() {
  const { data } = useQuery<{ tenants: Record<string, number>; subscriptions: Record<string, number>; mrr: number; arr: number; ordersToday: number; health: { failedJobs: number; deadNotifications: number; integrationErrors: number }; backup: { at: string | null; ok: boolean; error?: string } }>({ queryKey: ['platform-overview'], queryFn: () => get('/platform/overview') });
  if (!data) return <Skeleton className="h-40" />;
  const total = Object.values(data.tenants).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tenants" value={total} hint={`${data.tenants.active ?? 0} active · ${data.tenants.trial ?? 0} trial · ${data.tenants.suspended ?? 0} suspended`} icon={<Building2 className="h-5 w-5" />} />
        <Stat label="MRR" value={money(data.mrr)} hint={`ARR ${money(data.arr)}`} icon={<Activity className="h-5 w-5" />} />
        <Stat label="Orders today (all tenants)" value={data.ordersToday} icon={<Activity className="h-5 w-5" />} />
        <Stat label="Last backup" value={data.backup.at ? dateTime(data.backup.at) : 'Never'} hint={data.backup.ok ? 'OK' : data.backup.error} icon={<DatabaseBackup className="h-5 w-5" />} tone={data.backup.ok ? 'default' : 'red'} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Failed background jobs" value={data.health.failedJobs} tone={data.health.failedJobs ? 'red' : 'default'} icon={<AlertTriangle className="h-5 w-5" />} />
        <Stat label="Undelivered notifications" value={data.health.deadNotifications} tone={data.health.deadNotifications ? 'yellow' : 'default'} icon={<AlertTriangle className="h-5 w-5" />} />
        <Stat label="Integrations in error" value={data.health.integrationErrors} tone={data.health.integrationErrors ? 'yellow' : 'default'} icon={<AlertTriangle className="h-5 w-5" />} />
      </div>
      <Card title="Subscriptions by status"><div className="flex flex-wrap gap-3">{Object.entries(data.subscriptions).map(([k, v]) => <span key={k} className="flex items-center gap-2"><StatusPill status={k} /> <b>{v}</b></span>)}</div></Card>
    </div>
  );
}

function Tenants() {
  const { handleError, toast, confirm } = useFeedback();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<Tenant[]>({ queryKey: ['platform-tenants', q], queryFn: () => get('/platform/tenants', { q: q || undefined }) });
  const plans = useQuery<Plan[]>({ queryKey: ['platform-plans'], queryFn: () => get('/platform/plans') });
  const [create, setCreate] = useState<any>(null);
  const [renew, setRenew] = useState<null | { tenant: Tenant; planCode: string; interval: string; periods: number }>(null);
  const setStatus = async (t: Tenant, status: string) => {
    const c = await confirm({ title: `${titleCase(status)} ${t.name}?`, message: status === 'suspended' ? 'Users of this tenant will be blocked immediately.' : 'Access will be restored.', reason: status === 'suspended', danger: status === 'suspended' });
    if (c.ok) post(`/platform/tenants/${t._id}/status`, { status, reason: c.reason }).then(() => { qc.invalidateQueries({ queryKey: ['platform-tenants'] }); toast(`Tenant ${status}`); }).catch(handleError);
  };
  return (
    <Card title="Tenants" actions={<><Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" /><Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate({ name: '', slug: '', planCode: plans.data?.[0]?.code ?? 'starter', branch: { name: 'Main', code: 'MAIN' }, owner: { name: '', email: '', password: '' } })}>Tenant</Button></>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'n', header: 'Tenant', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.slug}</p></div> },
        { key: 'p', header: 'Plan', render: (r) => r.subscription?.plan ?? '—' }, { key: 's', header: 'Status', render: (r) => <div className="flex gap-1"><StatusPill status={r.status} />{r.subscription && <StatusPill status={r.subscription.status} />}</div> },
        { key: 'e', header: 'Renews / trial ends', render: (r) => dateTime(r.subscription?.status === 'trialing' ? r.subscription.trialEndsAt : r.subscription?.currentPeriodEnd) },
        { key: 'b', header: 'Branches', render: (r) => r.branches }, { key: 'c', header: 'Created', render: (r) => dateTime(r.createdAt) },
        { key: 'a', header: '', render: (r) => <div className="flex gap-1">{r.status !== 'suspended' ? <Button size="sm" variant="ghost" onClick={() => setStatus(r, 'suspended')}>Suspend</Button> : <Button size="sm" variant="secondary" onClick={() => setStatus(r, 'active')}>Activate</Button>}<Button size="sm" variant="secondary" onClick={() => setRenew({ tenant: r, planCode: plans.data?.find((p) => p.name === r.subscription?.plan)?.code ?? 'starter', interval: 'monthly', periods: 1 })}>Renew</Button></div> },
      ]} />
      {create && <Modal open onClose={() => setCreate(null)} title="Create tenant" footer={<Button onClick={() => post('/platform/tenants', create).then(() => { qc.invalidateQueries({ queryKey: ['platform-tenants'] }); setCreate(null); toast('Tenant created'); }).catch(handleError)}>Create</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Business name"><Input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value, slug: create.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} /></Field>
          <Field label="Subdomain"><Input value={create.slug} onChange={(e) => setCreate({ ...create, slug: e.target.value })} /></Field>
          <Field label="Plan"><Select value={create.planCode} onChange={(e) => setCreate({ ...create, planCode: e.target.value })}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
          <Field label="First branch"><Input value={create.branch.name} onChange={(e) => setCreate({ ...create, branch: { ...create.branch, name: e.target.value } })} /></Field>
          <Field label="Branch code"><Input value={create.branch.code} onChange={(e) => setCreate({ ...create, branch: { ...create.branch, code: e.target.value.toUpperCase() } })} /></Field>
          <Field label="Owner name"><Input value={create.owner.name} onChange={(e) => setCreate({ ...create, owner: { ...create.owner, name: e.target.value } })} /></Field>
          <Field label="Owner email"><Input value={create.owner.email} onChange={(e) => setCreate({ ...create, owner: { ...create.owner, email: e.target.value } })} /></Field>
          <Field label="Owner temporary password"><Input type="password" value={create.owner.password} onChange={(e) => setCreate({ ...create, owner: { ...create.owner, password: e.target.value } })} /></Field>
        </div>
      </Modal>}
      {renew && <Modal open onClose={() => setRenew(null)} title={`Renew ${renew.tenant.name}`} footer={<Button onClick={() => post(`/platform/tenants/${renew.tenant._id}/subscription`, { planCode: renew.planCode, interval: renew.interval, periods: renew.periods }).then(() => { qc.invalidateQueries({ queryKey: ['platform-tenants'] }); setRenew(null); toast('Subscription renewed'); }).catch(handleError)}>Renew</Button>}>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Plan"><Select value={renew.planCode} onChange={(e) => setRenew({ ...renew, planCode: e.target.value })}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field><Field label="Interval"><Select value={renew.interval} onChange={(e) => setRenew({ ...renew, interval: e.target.value })}><option value="monthly">Monthly</option><option value="annual">Annual</option></Select></Field><Field label="Periods"><Input type="number" min={1} value={renew.periods} onChange={(e) => setRenew({ ...renew, periods: Number(e.target.value) })} /></Field></div>
      </Modal>}
    </Card>
  );
}

function Plans() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<Plan[]>({ queryKey: ['platform-plans'], queryFn: () => get('/platform/plans') });
  const [f, setF] = useState<Plan | null>(null);
  return (
    <Card title="Plans & entitlements" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ _id: '', code: '', name: '', priceMonthly: 0, priceAnnual: 0, trialDays: 14, limits: { branches: 1, users: 10, terminals: 2, products: 500 }, features: ['pos'], active: true })}>Plan</Button>}>
      <DataTable rows={data} rowKey={(r) => r.code} onRowClick={setF} columns={[{ key: 'n', header: 'Plan', render: (r) => <b>{r.name}</b> }, { key: 'm', header: 'Monthly', render: (r) => money(r.priceMonthly) }, { key: 'a', header: 'Annual', render: (r) => money(r.priceAnnual) }, { key: 'l', header: 'Limits', render: (r) => <span className="text-xs">{Object.entries(r.limits).map(([k, v]) => `${k} ${v}`).join(' · ')}</span> }, { key: 'f', header: 'Features', render: (r) => r.features.length }, { key: 's', header: '', render: (r) => (r.active ? <Pill color="green">active</Pill> : <Pill>retired</Pill>) }]} />
      {f && <Modal open onClose={() => setF(null)} title={f._id ? `Edit ${f.name}` : 'New plan'} size="lg" footer={<Button onClick={() => put(`/platform/plans/${f.code}`, { code: f.code, name: f.name, description: f.description, priceMonthly: f.priceMonthly, priceAnnual: f.priceAnnual, trialDays: f.trialDays, limits: f.limits, features: f.features, active: f.active }).then(() => { qc.invalidateQueries({ queryKey: ['platform-plans'] }); setF(null); toast('Plan saved'); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code"><Input disabled={!!f._id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Trial days"><Input type="number" value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: Number(e.target.value) })} /></Field>
          <Field label="Monthly (KSh)"><Input value={fromCents(f.priceMonthly)} onChange={(e) => setF({ ...f, priceMonthly: toCents(e.target.value || 0) })} /></Field>
          <Field label="Annual (KSh)"><Input value={fromCents(f.priceAnnual)} onChange={(e) => setF({ ...f, priceAnnual: toCents(e.target.value || 0) })} /></Field>
          <div />
          {Object.keys(f.limits).map((k) => <Field key={k} label={`Max ${k}`}><Input type="number" value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: Number(e.target.value) } })} /></Field>)}
          <div className="sm:col-span-3"><p className="label">Features</p><div className="flex flex-wrap gap-2">{FEATURES.map((x) => <button key={x} type="button" onClick={() => setF({ ...f, features: f.features.includes(x) ? f.features.filter((y) => y !== x) : [...f.features, x] })} className={`rounded-full border px-3 py-1 text-xs font-semibold ${f.features.includes(x) ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line'}`}>{titleCase(x)}</button>)}</div></div>
        </div>
      </Modal>}
    </Card>
  );
}

function Health() {
  const jobs = useQuery<{ jobs: Array<{ _id: { type: string; status: string }; n: number }>; notifications: Array<{ _id: { channel: string; status: string }; n: number }> }>({ queryKey: ['platform-jobs'], queryFn: () => get('/platform/jobs') });
  const integ = useQuery<Array<{ _id: { kind: string; state: string }; n: number }>>({ queryKey: ['platform-integ'], queryFn: () => get('/platform/integrations') });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Notification queue (all tenants)"><DataTable rows={jobs.data?.notifications} loading={jobs.isLoading} rowKey={(r) => r._id.channel + r._id.status} columns={[{ key: 'c', header: 'Channel', render: (r) => r._id.channel }, { key: 's', header: 'Status', render: (r) => <StatusPill status={r._id.status} /> }, { key: 'n', header: 'Count', render: (r) => r.n }]} /></Card>
      <Card title="Integration health (no tenant data)"><DataTable rows={integ.data} loading={integ.isLoading} rowKey={(r) => r._id.kind + r._id.state} columns={[{ key: 'k', header: 'Integration', render: (r) => titleCase(r._id.kind) }, { key: 's', header: 'State', render: (r) => <StatusPill status={r._id.state} /> }, { key: 'n', header: 'Tenants', render: (r) => r.n }]} /></Card>
    </div>
  );
}

function PlatformAudit() {
  const { data, isLoading } = useQuery<Array<{ _id: string; createdAt: string; actorName?: string; action: string; reason?: string }>>({ queryKey: ['platform-audit'], queryFn: () => get('/platform/audit') });
  return <Card><DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) }, { key: 'u', header: 'Admin', render: (r) => r.actorName }, { key: 'a', header: 'Action', render: (r) => <code className="text-xs">{r.action}</code> }, { key: 'r', header: 'Reason', render: (r) => r.reason }]} /></Card>;
}
