import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Download, Plus, ShieldAlert, Clock } from 'lucide-react';
import { download, get, post, patch } from '@/lib/api';
import { dateTime, time } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Textarea } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Emp { _id: string; employeeNo: string; name: string; phone?: string; jobTitle?: string; deviceUserCode?: string; active: boolean; biometricConsent?: { given: boolean; at?: string } }
interface Device { _id: string; name: string; vendor: string; deviceType: string; model?: string; connection: string; host?: string; port?: number; status: string; verified: boolean; lastSeenAt?: string; lastSyncAt?: string; lastError?: string; bridgeId?: string }
type TabId = 'attendance' | 'employees' | 'shifts' | 'devices' | 'events';

export default function StaffPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<TabId>(can('attendance.view') ? 'attendance' : 'employees');
  return (
    <div>
      <PageHeader title="Staff & attendance" subtitle="Employees, shifts, biometric devices and attendance reports" />
      <Tabs<TabId> tabs={[{ id: 'attendance', label: 'Attendance report', hidden: !can('attendance.view') }, { id: 'events', label: 'Clock events', hidden: !can('attendance.view') }, { id: 'employees', label: 'Employees' }, { id: 'shifts', label: 'Shifts' }, { id: 'devices', label: 'Devices', hidden: !can('devices.manage') }]} value={tab} onChange={setTab} />
      {tab === 'attendance' && <Report />}
      {tab === 'events' && <Events />}
      {tab === 'employees' && <Employees />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'devices' && <Devices />}
    </div>
  );
}

function Report() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const range = { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() };
  const { data, isLoading } = useQuery<{ rows: Array<{ employeeId: string; employeeName: string; date: string; firstIn: string; lastOut?: string; workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number; missingClockOut: boolean; shift?: string }>; summary: Array<{ employeeId: string; employeeName: string; days: number; workedMinutes: number; lateDays: number; overtimeMinutes: number; missingClockOuts: number }> }>({ queryKey: ['attendance', from, to], queryFn: () => get('/staff/attendance/report', range) });
  const h = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;
  return (
    <div className="space-y-4">
      <Card title="Summary" actions={<><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /><Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => download('/staff/attendance/report', { ...range, format: 'csv' }, `attendance-${from}-${to}.csv`)}>CSV</Button></>}>
        <DataTable rows={data?.summary} loading={isLoading} rowKey={(r) => r.employeeId} columns={[
          { key: 'n', header: 'Employee', render: (r) => <b>{r.employeeName}</b> }, { key: 'd', header: 'Days', render: (r) => r.days }, { key: 'w', header: 'Worked', render: (r) => h(r.workedMinutes) },
          { key: 'l', header: 'Late days', render: (r) => (r.lateDays ? <Pill color="yellow">{r.lateDays}</Pill> : 0) }, { key: 'o', header: 'Overtime', render: (r) => h(r.overtimeMinutes) }, { key: 'm', header: 'Missing clock-out', render: (r) => (r.missingClockOuts ? <Pill color="red">{r.missingClockOuts}</Pill> : 0) },
        ]} />
      </Card>
      <Card title="Daily detail">
        <DataTable rows={data?.rows} loading={isLoading} rowKey={(r) => r.employeeId + r.date} columns={[
          { key: 'd', header: 'Date', render: (r) => r.date }, { key: 'n', header: 'Employee', render: (r) => r.employeeName }, { key: 's', header: 'Shift', render: (r) => r.shift ?? '—' },
          { key: 'i', header: 'In', render: (r) => time(r.firstIn) }, { key: 'o', header: 'Out', render: (r) => (r.lastOut ? time(r.lastOut) : <Pill color="red">missing</Pill>) }, { key: 'w', header: 'Worked', render: (r) => h(r.workedMinutes) },
          { key: 'l', header: 'Late', render: (r) => (r.lateMinutes ? `${r.lateMinutes}m` : '—') }, { key: 'e', header: 'Early leave', render: (r) => (r.earlyLeaveMinutes ? `${r.earlyLeaveMinutes}m` : '—') }, { key: 'ot', header: 'Overtime', render: (r) => (r.overtimeMinutes ? `${r.overtimeMinutes}m` : '—') },
        ]} />
      </Card>
    </div>
  );
}

function Events() {
  const { can, session } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const emps = useQuery<Emp[]>({ queryKey: ['employees'], queryFn: () => get('/staff/employees') });
  const { data, isLoading } = useQuery<Array<{ _id: string; employeeId?: string; deviceUserCode?: string; type: string; at: string; source: string; verifyMode?: string; unmatched?: boolean; correction?: { status: string; reason: string; requestedBy: string } }>>({ queryKey: ['att-events'], queryFn: () => get('/staff/attendance/events', { from: new Date(Date.now() - 7 * 86400_000).toISOString(), to: new Date().toISOString() }) });
  const [corr, setCorr] = useState(false);
  const [f, setF] = useState({ employeeId: '', type: 'clock_out', at: '', reason: '' });
  const name = (id?: string) => emps.data?.find((e) => e._id === id)?.name;
  return (
    <Card title="Last 7 days" actions={can('attendance.manage') && <Button size="sm" icon={<Clock className="h-4 w-4" />} onClick={() => setCorr(true)}>Manual correction</Button>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'a', header: 'When', render: (r) => dateTime(r.at) }, { key: 'e', header: 'Employee', render: (r) => name(r.employeeId) ?? <Pill color="red">Unmatched code {r.deviceUserCode}</Pill> },
        { key: 't', header: 'Type', render: (r) => r.type.replace('_', ' ') }, { key: 's', header: 'Source', render: (r) => `${r.source}${r.verifyMode ? ` · ${r.verifyMode}` : ''}` },
        { key: 'c', header: 'Correction', render: (r) => r.correction ? <div className="flex items-center gap-1"><StatusPill status={r.correction.status} />{r.correction.status === 'pending' && can('attendance.approve') && r.correction.requestedBy !== session?.user.id && <><Button size="sm" onClick={() => post(`/staff/attendance/corrections/${r._id}/decision`, { approve: true }).then(() => qc.invalidateQueries({ queryKey: ['att-events'] })).catch(handleError)}>Approve</Button><Button size="sm" variant="ghost" onClick={() => post(`/staff/attendance/corrections/${r._id}/decision`, { approve: false }).then(() => qc.invalidateQueries({ queryKey: ['att-events'] })).catch(handleError)}>Reject</Button></>}</div> : null },
      ]} />
      <Modal open={corr} onClose={() => setCorr(false)} title="Manual attendance correction" footer={<Button disabled={!f.employeeId || !f.at || f.reason.length < 3} onClick={() => post('/staff/attendance/corrections', { ...f, at: new Date(f.at).toISOString() }).then(() => { setCorr(false); qc.invalidateQueries({ queryKey: ['att-events'] }); toast('Correction submitted for approval'); }).catch(handleError)}>Submit</Button>}>
        <div className="space-y-3">
          <Field label="Employee"><Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select…</option>{emps.data?.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</Select></Field>
          <Field label="Event"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="clock_in">Clock in</option><option value="clock_out">Clock out</option><option value="break_start">Break start</option><option value="break_end">Break end</option></Select></Field>
          <Field label="Time"><Input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></Field>
          <Field label="Reason"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <p className="text-xs text-ink-soft">Corrections need approval from a different person and are audited.</p>
        </div>
      </Modal>
    </Card>
  );
}

function Employees() {
  const { can } = useAuth();
  const { handleError, toast, confirm } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Emp[]>({ queryKey: ['employees'], queryFn: () => get('/staff/employees') });
  const devices = useQuery<Device[]>({ queryKey: ['devices'], queryFn: () => get('/staff/devices'), enabled: can('biometric.enroll') });
  const [form, setForm] = useState<null | Partial<Emp>>(null);
  const consent = async (e: Emp, given: boolean) => {
    const c = await confirm({ title: given ? 'Record biometric consent' : 'Withdraw consent', message: given ? <>Confirm that <b>{e.name}</b> has read the biometric privacy notice and gave informed, voluntary consent. They may instead use PIN/manual attendance.</> : 'Withdrawing consent queues deletion of their fingerprint templates from devices.', confirmLabel: given ? 'Consent given' : 'Withdraw' });
    if (c.ok) post(`/staff/employees/${e._id}/biometric-consent`, { given }).then(() => { qc.invalidateQueries({ queryKey: ['employees'] }); toast('Recorded'); }).catch(handleError);
  };
  const enroll = (e: Emp) => {
    const dev = devices.data?.[0];
    if (!dev) return toast('Register a biometric device first', 'error');
    post(`/staff/devices/${dev._id}/enroll`, { employeeId: e._id }).then(() => toast(`Enrolment queued on ${dev.name}. Ask ${e.name} to place their finger on the reader.`)).catch(handleError);
  };
  return (
    <Card title="Employees" actions={can('staff.manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({})}>Employee</Button>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'no', header: 'No.', render: (r) => r.employeeNo }, { key: 'n', header: 'Name', render: (r) => <b>{r.name}</b> }, { key: 't', header: 'Role', render: (r) => r.jobTitle },
        { key: 'd', header: 'Device code', render: (r) => r.deviceUserCode ?? '—' },
        { key: 'c', header: 'Biometric consent', render: (r) => (r.biometricConsent?.given ? <Pill color="green">Given</Pill> : <Pill>Not given</Pill>) },
        { key: 'a', header: '', render: (r) => <div className="flex gap-1">
          {can('staff.manage') && <Button size="sm" variant="ghost" onClick={() => setForm(r)}>Edit</Button>}
          {can('biometric.enroll') && <Button size="sm" variant="secondary" onClick={() => consent(r, !r.biometricConsent?.given)}>{r.biometricConsent?.given ? 'Withdraw consent' : 'Record consent'}</Button>}
          {can('biometric.enroll') && r.biometricConsent?.given && <Button size="sm" icon={<Fingerprint className="h-4 w-4" />} onClick={() => enroll(r)}>Enrol</Button>}
        </div> },
      ]} />
      {form && (
        <Modal open onClose={() => setForm(null)} title={form._id ? 'Edit employee' : 'New employee'} footer={<Button onClick={() => (form._id ? patch(`/staff/employees/${form._id}`, { name: form.name, phone: form.phone, jobTitle: form.jobTitle, deviceUserCode: form.deviceUserCode || undefined }) : post('/staff/employees', { employeeNo: form.employeeNo, name: form.name, phone: form.phone || undefined, jobTitle: form.jobTitle, deviceUserCode: form.deviceUserCode || undefined })).then(() => { qc.invalidateQueries({ queryKey: ['employees'] }); setForm(null); }).catch(handleError)}>Save</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Employee no."><Input disabled={!!form._id} value={form.employeeNo ?? ''} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} /></Field>
            <Field label="Name"><Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Phone"><Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Job title"><Input value={form.jobTitle ?? ''} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
            <Field label="Device user code" hint="The numeric ID used on attendance terminals"><Input inputMode="numeric" value={form.deviceUserCode ?? ''} onChange={(e) => setForm({ ...form, deviceUserCode: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Shifts() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; name: string; start: string; end: string; breakMinutes: number; graceMinutes: number }>>({ queryKey: ['shifts'], queryFn: () => get('/staff/shifts') });
  const emps = useQuery<Emp[]>({ queryKey: ['employees'], queryFn: () => get('/staff/employees') });
  const [f, setF] = useState({ name: '', start: '08:00', end: '17:00', breakMinutes: '60', graceMinutes: '10' });
  const [assign, setAssign] = useState<{ shiftId: string; employeeIds: string[]; from: string; to: string } | null>(null);
  return (
    <Card title="Shifts" actions={can('attendance.manage') && <div className="flex flex-wrap gap-2"><Input placeholder="Name" className="w-28" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input type="time" className="w-28" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /><Input type="time" className="w-28" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /><Button size="sm" onClick={() => post('/staff/shifts', { ...f, breakMinutes: Number(f.breakMinutes), graceMinutes: Number(f.graceMinutes) }).then(() => { qc.invalidateQueries({ queryKey: ['shifts'] }); toast('Shift added'); }).catch(handleError)}>Add</Button></div>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'n', header: 'Shift', render: (r) => <b>{r.name}</b> }, { key: 't', header: 'Hours', render: (r) => `${r.start}–${r.end}` }, { key: 'b', header: 'Break', render: (r) => `${r.breakMinutes}m` }, { key: 'g', header: 'Grace', render: (r) => `${r.graceMinutes}m` }, { key: 'a', header: '', render: (r) => can('attendance.manage') && <Button size="sm" variant="secondary" onClick={() => setAssign({ shiftId: r._id, employeeIds: [], from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10) })}>Assign</Button> }]} />
      {assign && (
        <Modal open onClose={() => setAssign(null)} title="Assign shift" footer={<Button onClick={() => { const dates: string[] = []; for (let d = new Date(assign.from); d <= new Date(assign.to); d = new Date(d.getTime() + 86400_000)) dates.push(d.toISOString().slice(0, 10)); post('/staff/shifts/assign', { shiftId: assign.shiftId, employeeIds: assign.employeeIds, dates }).then((r: { assigned: number }) => { toast(`${r.assigned} assignments saved`); setAssign(null); }).catch(handleError); }}>Save</Button>}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2"><Field label="From"><Input type="date" value={assign.from} onChange={(e) => setAssign({ ...assign, from: e.target.value })} /></Field><Field label="To"><Input type="date" value={assign.to} onChange={(e) => setAssign({ ...assign, to: e.target.value })} /></Field></div>
            <div className="max-h-64 space-y-1 overflow-y-auto">{emps.data?.map((e) => <label key={e._id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand" checked={assign.employeeIds.includes(e._id)} onChange={(ev) => setAssign({ ...assign, employeeIds: ev.target.checked ? [...assign.employeeIds, e._id] : assign.employeeIds.filter((x) => x !== e._id) })} />{e.name}</label>)}</div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Devices() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Device[]>({ queryKey: ['devices'], queryFn: () => get('/staff/devices'), refetchInterval: 30_000 });
  const bridges = useQuery<{ bridges: Array<{ _id: string; name: string; lastSeenAt?: string; active: boolean }> }>({ queryKey: ['integrations'], queryFn: () => get('/integrations') });
  const [f, setF] = useState<null | { name: string; vendor: string; model: string; host: string; port: string; bridgeId: string }>(null);
  const cmd = (d: Device, type: string) => post<{ simulated?: boolean }>(`/staff/devices/${d._id}/commands`, { type }).then((r) => toast(r.simulated ? 'SIMULATED device — no hardware contacted' : `Command queued for the bridge (${type.replace('_', ' ')})`)).catch(handleError);
  return (
    <Card title="Biometric devices" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ name: '', vendor: 'zkteco', model: '', host: '', port: '4370', bridgeId: bridges.data?.bridges.find((b) => b.active)?._id ?? '' })}>Register device</Button>}>
      <div className="mb-4 flex gap-3 rounded-xl bg-warn-pale p-3 text-sm text-warn-ink"><ShieldAlert className="h-5 w-5 shrink-0" /><p>Fingerprint data is sensitive personal data under Kenya’s Data Protection Act, 2019. Templates stay on the device or the local bridge — the cloud stores only enrolment references and clock events. Record consent first, offer a PIN alternative, and complete a DPIA before production use. Devices are <b>unverified</b> until physically tested.</p></div>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'n', header: 'Device', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.vendor} {r.model} · {r.connection}{r.host ? ` · ${r.host}:${r.port}` : ''}</p></div> },
        { key: 's', header: 'Status', render: (r) => <div className="flex flex-col gap-1"><StatusPill status={r.status} />{r.lastError && <span className="text-xs text-danger">{r.lastError}</span>}</div> },
        { key: 'v', header: 'Verified', render: (r) => (r.verified ? <Pill color="green">Verified</Pill> : <Pill color="yellow">Unverified</Pill>) },
        { key: 'l', header: 'Last sync', render: (r) => dateTime(r.lastSyncAt) },
        { key: 'a', header: '', render: (r) => <div className="flex flex-wrap gap-1"><Button size="sm" variant="secondary" onClick={() => cmd(r, 'device_test')}>Test</Button><Button size="sm" variant="ghost" onClick={() => cmd(r, 'sync_time')}>Sync clock</Button><Button size="sm" variant="ghost" onClick={() => cmd(r, 'pull_attendance')}>Pull logs</Button>{!r.verified && <Button size="sm" variant="ghost" onClick={() => { const notes = window.prompt('Describe the physical test you performed (model, firmware, enrol + punch verified):'); if (notes) patch(`/staff/devices/${r._id}`, { verified: true, verificationNotes: notes }).then(() => qc.invalidateQueries({ queryKey: ['devices'] })).catch(handleError); }}>Mark verified</Button>}</div> },
      ]} />
      {f && (
        <Modal open onClose={() => setF(null)} title="Register biometric device" footer={<Button onClick={() => post('/staff/devices', f.vendor === 'zkteco' ? { name: f.name, vendor: 'zkteco', deviceType: 'zkteco_terminal', model: f.model, connection: 'udp', host: f.host, port: Number(f.port), bridgeId: f.bridgeId } : f.vendor === 'secugen' ? { name: f.name, vendor: 'secugen', deviceType: 'secugen_usb', model: f.model, connection: 'usb_bridge', bridgeId: f.bridgeId } : { name: f.name, vendor: 'mock', deviceType: 'mock', connection: 'mock' }).then(() => { qc.invalidateQueries({ queryKey: ['devices'] }); setF(null); toast('Device registered (unverified)'); }).catch(handleError)}>Register</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })}><option value="zkteco">ZKTeco network terminal</option><option value="secugen">SecuGen USB reader (via bridge)</option><option value="mock">Simulated (development)</option></Select></Field>
            <Field label="Model"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder={f.vendor === 'zkteco' ? 'e.g. K40, MB460' : 'e.g. Hamster Pro 20'} /></Field>
            {f.vendor !== 'mock' && <Field label="Bridge"><Select value={f.bridgeId} onChange={(e) => setF({ ...f, bridgeId: e.target.value })}><option value="">Select…</option>{bridges.data?.bridges.filter((b) => b.active).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}</Select></Field>}
            {f.vendor === 'zkteco' && <><Field label="LAN IP"><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="192.168.1.201" /></Field><Field label="Port"><Input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field></>}
          </div>
        </Modal>
      )}
    </Card>
  );
}
