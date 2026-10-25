import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Smartphone, MessageSquare, MessageCircle, Mail, Printer, ChefHat, Fingerprint, Usb, Globe, FileSpreadsheet, FlaskConical, KeyRound, RotateCcw, Copy, Plus } from 'lucide-react';
import { get, post, put } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Toggle, Textarea, Skeleton } from '@/components/ui';
import { useFeedback } from '@/components/feedback';

interface IntegrationView {
  kind: string;
  setup: string;
  secretKeys: string[];
  derived: Record<string, unknown> | null;
  recentLogs: Array<{ action: string; ok: boolean; message: string; simulated?: boolean; at: string }>;
  config: null | { provider: string; enabled: boolean; environment: string; settings: Record<string, string>; secretHints: Record<string, string>; secretsConfigured: string[]; c2bRegistered?: boolean; smsWebhookConfigured?: boolean; status: { state: string; lastTestAt?: string; lastTestOk?: boolean; lastTestMessage?: string; lastSuccessAt?: string; lastError?: string; lastErrorAt?: string; simulated?: boolean } };
}
interface Overview { mocksAllowed: boolean; publicApiUrl: string; integrations: IntegrationView[]; bridges: Array<{ _id: string; name: string; lastSeenAt?: string; version?: string; active: boolean; tokenHint?: string }> }

const META: Record<string, { title: string; icon: typeof Smartphone }> = {
  mpesa: { title: 'M-Pesa Daraja', icon: Smartphone }, sms: { title: 'Talk Sasa SMS', icon: MessageSquare }, whatsapp: { title: 'WhatsApp', icon: MessageCircle }, email: { title: 'SMTP email', icon: Mail },
  receipt_printer: { title: 'Receipt printers', icon: Printer }, kitchen_printer: { title: 'Kitchen & bar printers', icon: ChefHat }, zkteco: { title: 'ZKTeco devices', icon: Fingerprint },
  secugen: { title: 'SecuGen readers', icon: Usb }, online_ordering: { title: 'Online ordering', icon: Globe }, accounting_export: { title: 'Accounting exports', icon: FileSpreadsheet },
};

/** Status shown honestly: green only after a real (non-simulated) test or operation succeeded. */
function HonestStatus({ i }: { i: IntegrationView }) {
  const c = i.config;
  if (i.derived) return <Pill color={(i.derived.count as number) ? 'blue' : 'gray'}>{(i.derived.count as number) ? `${i.derived.count} configured` : 'Not set up'}</Pill>;
  if (!c) return <Pill>Not configured</Pill>;
  if (!c.enabled) return <Pill>Disabled</Pill>;
  if (c.provider === 'mock') return <Pill color="yellow"><FlaskConical className="h-3 w-3" /> Simulated</Pill>;
  if (c.status.state === 'error') return <Pill color="red">Error</Pill>;
  if (c.status.lastTestOk) return <Pill color="green">Connected</Pill>;
  return <Pill color="yellow">Not tested</Pill>;
}

export default function IntegrationsPage() {
  const [tab, setTab] = useState<'centre' | 'printers' | 'bridges' | 'queue' | 'templates'>('centre');
  const { data, isLoading } = useQuery<Overview>({ queryKey: ['integrations'], queryFn: () => get('/integrations') });
  const [edit, setEdit] = useState<IntegrationView | null>(null);
  return (
    <div>
      <PageHeader title="Integration management centre" subtitle="Payments, messaging, printers and attendance devices. Connections are shown as connected only after a real test passes." />
      <Tabs tabs={[{ id: 'centre', label: 'Integrations' }, { id: 'printers', label: 'Printers' }, { id: 'bridges', label: 'Local bridges' }, { id: 'queue', label: 'Message queue & logs' }, { id: 'templates', label: 'Message templates' }]} value={tab} onChange={setTab} />
      {tab === 'centre' && (isLoading || !data ? <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}</div> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.integrations.map((i) => {
            const M = META[i.kind];
            const s = i.config?.status;
            return (
              <Card key={i.kind} padded={false} className="flex flex-col">
                <div className="flex items-start justify-between gap-3 p-5 pb-3">
                  <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-pale text-brand-dark"><M.icon className="h-5 w-5" /></span><div><p className="font-semibold">{M.title}</p><p className="text-xs text-ink-soft">{i.config ? `${i.config.provider}${i.config.environment && i.config.provider !== 'mock' ? ` · ${i.config.environment}` : ''}` : 'Not configured'}</p></div></div>
                  <HonestStatus i={i} />
                </div>
                <div className="flex-1 space-y-1 px-5 text-xs text-ink-soft">
                  {i.config && <p>Credentials: {i.secretKeys.length ? i.secretKeys.map((k) => <span key={k} className="mr-1">{k} {i.config!.secretHints[k] ? <b className="text-ink">{i.config!.secretHints[k]}</b> : <span className="text-danger">missing</span>}</span>) : 'none required'}</p>}
                  {s?.lastTestAt && <p>Last test {dateTime(s.lastTestAt)}: <span className={s.lastTestOk ? 'text-brand-dark' : 'text-danger'}>{s.lastTestMessage}</span></p>}
                  {s?.lastSuccessAt && <p>Last success {dateTime(s.lastSuccessAt)}</p>}
                  {s?.lastError && <p className="text-danger">Last error {dateTime(s.lastErrorAt)}: {s.lastError}</p>}
                  {i.derived && Object.entries(i.derived).filter(([, v]) => v !== null).map(([k2, v]) => <p key={k2}>{k2}: <b className="text-ink">{String(v)}</b></p>)}
                </div>
                <div className="flex flex-wrap gap-2 border-t border-line p-4">
                  {['mpesa', 'sms', 'whatsapp', 'email'].includes(i.kind) ? <Button size="sm" onClick={() => setEdit(i)}>Configure & test</Button> : <Button size="sm" variant="secondary" onClick={() => setEdit(i)}>Setup guide</Button>}
                </div>
              </Card>
            );
          })}
        </div>
      ))}
      {tab === 'printers' && <Printers bridges={data?.bridges ?? []} />}
      {tab === 'bridges' && <Bridges bridges={data?.bridges ?? []} />}
      {tab === 'queue' && <Queue />}
      {tab === 'templates' && <Templates />}
      {edit && data && <ConfigureModal i={edit} mocksAllowed={data.mocksAllowed} publicApiUrl={data.publicApiUrl} onClose={() => setEdit(null)} />}
    </div>
  );
}

const FIELDS: Record<string, Array<{ key: string; label: string; secret?: boolean; hint?: string; type?: string; options?: Array<[string, string]> }>> = {
  mpesa: [
    { key: 'shortCode', label: 'Business short code', hint: 'Paybill, or store/HO number for Buy Goods. Sandbox: 174379' },
    { key: 'transactionType', label: 'Transaction type', options: [['CustomerPayBillOnline', 'Paybill'], ['CustomerBuyGoodsOnline', 'Buy Goods (Till)']] },
    { key: 'partyB', label: 'Till number (Buy Goods only)', hint: 'Leave blank for Paybill' },
    { key: 'consumerKey', label: 'Consumer key', secret: true },
    { key: 'consumerSecret', label: 'Consumer secret', secret: true },
    { key: 'passkey', label: 'Lipa Na M-Pesa passkey', secret: true },
    { key: 'callbackBaseUrl', label: 'Callback base URL', hint: 'Public HTTPS address of this server (not a 192.168.x / 172.x / 10.x address). Callbacks go to …/api/v1/payhooks/… (Safaricom refuses URLs containing "mpesa"). Without one, payments are still confirmed by status checks every few seconds.' },
    { key: 'accountReferenceFormat', label: 'Account reference format', hint: '{order} is replaced by the order number (max 12 chars)' },
    { key: 'transactionDesc', label: 'Transaction description', hint: 'Max 13 characters' },
    { key: 'verifyCallbackWithQuery', label: 'Verify success callbacks with a status query', options: [['true', 'Yes (recommended)'], ['false', 'No']] },
    { key: 'fetchPayerName', label: 'Show the payer’s M-Pesa name', options: [['true', 'Yes'], ['false', 'No']], hint: 'Asks Safaricom (Transaction Status API) who paid after each prompt payment. Needs the initiator below and a public callback base URL.' },
    { key: 'initiatorName', label: 'Initiator name', hint: 'API user from the M-Pesa org portal with the “Transaction Status Query” role (sandbox: testapi)' },
    { key: 'securityCredential', label: 'Security credential', secret: true, hint: 'The encrypted initiator password from the Daraja portal (or fill the two fields below instead)' },
    { key: 'initiatorPassword', label: 'Initiator password', secret: true, hint: 'Used with the certificate below when no security credential is given' },
    { key: 'certificate', label: 'Safaricom certificate (PEM)', hint: 'Paste the sandbox or production certificate from the Daraja portal' },
  ],
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone number ID', hint: 'Meta Business → WhatsApp → API setup (not the phone number itself)' },
    { key: 'accessToken', label: 'Access token', secret: true, hint: 'A permanent System User token with whatsapp_business_messaging' },
    { key: 'mode', label: 'Message type', options: [['template', 'Approved template (recommended)'], ['text', 'Free text (only within 24 h of the customer writing)']] },
    { key: 'templateName', label: 'Template name', hint: 'Utility template with body "Message from {{1}}:\n\n{{2}}" — e.g. chili_message' },
    { key: 'templateLanguage', label: 'Template language code', hint: 'e.g. en, en_US — as approved in WhatsApp Manager' },
    { key: 'useFor', label: 'Use for customer messages', options: [['off', 'Only when chosen (receipts)'], ['instead_of_sms', 'Instead of SMS'], ['with_sms', 'As well as SMS']], hint: 'Order ready, delivery updates, reservations, payment confirmations…' },
    { key: 'apiVersion', label: 'Graph API version', hint: 'Default v21.0' },
  ],
  sms: [
    { key: 'baseUrl', label: 'API base URL', hint: 'Default https://bulksms.talksasa.com/api/v3 — confirm in your Talk Sasa dashboard' },
    { key: 'apiKey', label: 'API token', secret: true },
    { key: 'senderId', label: 'Sender ID', hint: 'Approved alphanumeric sender ID (max 11)' },
    { key: 'sendPath', label: 'Send endpoint path', hint: 'Default sms/send' },
    { key: 'balancePath', label: 'Balance endpoint path', hint: 'Default balance' },
  ],
  email: [
    { key: 'host', label: 'SMTP host', hint: 'e.g. smtp.zoho.com, smtp-relay.brevo.com, smtp.gmail.com' },
    { key: 'port', label: 'Port', hint: '587 (STARTTLS) or 465 (TLS)' },
    { key: 'security', label: 'Encryption', options: [['starttls', 'STARTTLS (587)'], ['tls', 'Implicit TLS (465)'], ['none', 'None (not recommended)']] },
    { key: 'user', label: 'Username' },
    { key: 'smtpPass', label: 'Password / app password', secret: true },
    { key: 'fromName', label: 'Sender name' },
    { key: 'fromEmail', label: 'Sender email' },
    { key: 'replyTo', label: 'Reply-to email' },
  ],
};

function ConfigureModal({ i, mocksAllowed, publicApiUrl, onClose }: { i: IntegrationView; mocksAllowed: boolean; publicApiUrl: string; onClose: () => void }) {
  const { handleError, toast , prompt } = useFeedback();
  const qc = useQueryClient();
  const fields = FIELDS[i.kind];
  const realProvider = { mpesa: 'daraja', sms: 'talksasa', whatsapp: 'meta', email: 'smtp' }[i.kind] ?? 'none';
  const [provider, setProvider] = useState(i.config?.provider ?? realProvider);
  const [enabled, setEnabled] = useState(i.config?.enabled ?? false);
  const [environment, setEnv] = useState(i.config?.environment === 'production' ? 'production' : 'sandbox');
  const [settings, setSettings] = useState<Record<string, string>>({ ...(i.config?.settings ?? {}) });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState('');
  const [result, setResult] = useState<null | { ok: boolean; message: string; simulated?: boolean }>(null);
  const [busy, setBusy] = useState(false);
  if (!fields) return <Modal open onClose={onClose} title={META[i.kind].title}><p className="text-sm">{i.setup}</p></Modal>;

  const save = async () => {
    setBusy(true);
    try {
      const s: Record<string, string | number | boolean> = {};
      for (const f of fields) if (!f.secret && settings[f.key] !== undefined && settings[f.key] !== '') s[f.key] = f.key === 'port' ? Number(settings[f.key]) : f.key === 'verifyCallbackWithQuery' ? settings[f.key] !== 'false' : settings[f.key];
      await put(`/integrations/${i.kind}`, { provider, enabled, environment: provider === 'mock' ? 'mock' : environment, settings: s, secrets });
      setSecrets({});
      qc.invalidateQueries({ queryKey: ['integrations'] });
      toast('Saved. Run a test to confirm the connection.');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; message: string; simulated?: boolean }>(`/integrations/${i.kind}/test`, { to: testTo || undefined });
      setResult(r);
      qc.invalidateQueries({ queryKey: ['integrations'] });
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={META[i.kind].title} size="lg" footer={<><Button variant="secondary" onClick={save} loading={busy}>Save</Button></>}>
      <div className="space-y-4">
        <p className="rounded-xl bg-page p-3 text-xs text-ink-soft">{i.setup}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-56">
            <option value={realProvider}>{META[i.kind].title}</option>
            {mocksAllowed && <option value="mock">Simulated (development only)</option>}
          </Select>
          {provider !== 'mock' && i.kind === 'mpesa' && <Select value={environment} onChange={(e) => setEnv(e.target.value)} className="w-40"><option value="sandbox">Sandbox</option><option value="production">Production</option></Select>}
        </div>
        {provider === 'mock' && <p className="rounded-xl bg-warn-pale p-3 text-xs text-warn-ink"><FlaskConical className="mr-1 inline h-3 w-3" />Simulated provider: nothing is sent to Safaricom, Talk Sasa or any mail server. Results are labelled SIMULATED and it cannot be enabled in production.</p>}
        {provider !== 'mock' && (
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.secret ? (i.config?.secretHints[f.key] ? `Saved (${i.config.secretHints[f.key]}). Leave blank to keep.` : 'Not set') : f.hint}>
                {f.options ? (
                  <Select value={settings[f.key] ?? f.options[0][0]} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })}>{f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                ) : f.secret ? (
                  <Input type="password" autoComplete="new-password" value={secrets[f.key] ?? ''} placeholder={i.config?.secretHints[f.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} />
                ) : (
                  <Input value={settings[f.key] ?? ''} placeholder={f.key === 'callbackBaseUrl' ? publicApiUrl : ''} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        )}
        <div className="rounded-xl border border-line p-4">
          <p className="mb-2 text-sm font-semibold">Test connection</p>
          <div className="flex flex-wrap gap-2">
            {i.kind !== 'mpesa' && <Input className="max-w-xs" placeholder={i.kind === 'sms' ? 'Phone to receive test SMS' : i.kind === 'whatsapp' ? 'WhatsApp number for the test' : 'Email to receive test'} value={testTo} onChange={(e) => setTestTo(e.target.value)} />}
            <Button onClick={test} loading={busy}>{i.kind === 'mpesa' ? 'Test Daraja authentication' : 'Send test'}</Button>
            {i.kind === 'mpesa' && provider === 'daraja' && <Button variant="secondary" onClick={() => post('/mpesa/c2b/register', {}).then(() => toast('C2B URLs registered with Daraja')).catch(handleError)}>Register C2B URLs</Button>}
            {i.kind === 'sms' && provider === 'talksasa' && <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => post<{ url: string }>('/integrations/sms/webhook-key').then((r) => { navigator.clipboard?.writeText(r.url); toast('Delivery-report URL copied (shown once)'); prompt({ title: 'Delivery-report URL', label: 'Paste this into Talk Sasa', defaultValue: r.url, readOnly: true, hint: 'Shown once — copy it now.' }); }).catch(handleError)}>Delivery-report URL</Button>}
          </div>
          {result && <p className={`mt-3 rounded-xl px-3 py-2 text-sm ${result.simulated ? 'bg-warn-pale text-warn-ink' : result.ok ? 'bg-brand-pale text-brand-dark' : 'bg-danger-pale text-danger'}`}>{result.simulated ? 'SIMULATED — ' : ''}{result.message}</p>}
        </div>
        {i.recentLogs.length > 0 && (
          <div>
            <p className="label">Recent activity</p>
            <ul className="space-y-1 text-xs">{i.recentLogs.map((l, idx) => <li key={idx} className="flex gap-2"><StatusPill status={l.ok ? 'ok' : 'error'} />{l.simulated && <Pill color="yellow">simulated</Pill>}<span className="text-ink-soft">{dateTime(l.at)}</span> {l.action}: {l.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Printers({ bridges }: { bridges: Overview['bridges'] }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; name: string; role: string; connection: string; host?: string; port?: number; paperWidth: number; lastStatus?: string; lastPrintAt?: string; lastError?: string; bridgeId?: string }>>({ queryKey: ['printers'], queryFn: () => get('/integrations/printers') });
  const jobs = useQuery<Array<{ _id: string; kind: string; status: string; error?: string; createdAt: string; copy: string }>>({ queryKey: ['print-jobs'], queryFn: () => get('/integrations/print-jobs') });
  const [f, setF] = useState<null | { name: string; role: string; connection: string; host: string; port: string; paperWidth: string; bridgeId: string }>(null);
  return (
    <div className="space-y-4">
      <Card title="Printers" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ name: '', role: 'receipt', connection: 'network', host: '', port: '9100', paperWidth: '80', bridgeId: bridges[0]?._id ?? '' })}>Add printer</Button>}>
        <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
          { key: 'n', header: 'Printer', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.connection}{r.host ? ` · ${r.host}:${r.port}` : ''} · {r.paperWidth}mm</p></div> },
          { key: 'r', header: 'Route', render: (r) => <Pill>{r.role}</Pill> },
          { key: 's', header: 'Status', render: (r) => <div>{r.lastStatus ? <StatusPill status={r.lastStatus} /> : <Pill>Not tested</Pill>}{r.lastError && <p className="text-xs text-danger">{r.lastError}</p>}</div> },
          { key: 'l', header: 'Last print', render: (r) => dateTime(r.lastPrintAt) },
          { key: 'a', header: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => post(`/integrations/printers/${r._id}/jobs`, { kind: 'test', dedupeKey: `test-${r._id}-${Date.now()}`, payload: { text: 'Chili POS test print' } }).then(() => { toast('Test job queued — the bridge will print it'); jobs.refetch(); }).catch(handleError)}>Test print</Button> },
        ]} />
      </Card>
      <Card title="Print log"><DataTable rows={jobs.data} loading={jobs.isLoading} rowKey={(r) => r._id} columns={[{ key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) }, { key: 'k', header: 'Job', render: (r) => `${r.kind} (${r.copy})` }, { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> }, { key: 'e', header: 'Error', render: (r) => <span className="text-xs text-danger">{r.error}</span> }]} /></Card>
      {f && <Modal open onClose={() => setF(null)} title="Add printer" footer={<Button onClick={() => post('/integrations/printers', { name: f.name, role: f.role, connection: f.connection, host: f.host || undefined, port: Number(f.port) || undefined, paperWidth: Number(f.paperWidth), bridgeId: f.connection === 'browser' ? undefined : f.bridgeId || undefined }).then(() => { setF(null); qc.invalidateQueries({ queryKey: ['printers'] }); toast('Printer added'); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Route"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="receipt">Receipts</option><option value="billing">Bills</option><option value="kitchen">Kitchen tickets</option><option value="bar">Bar tickets</option></Select></Field>
          <Field label="Connection"><Select value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value })}><option value="network">Network (ESC/POS, port 9100)</option><option value="usb">USB (via bridge)</option><option value="bluetooth">Bluetooth (via bridge)</option><option value="browser">Browser print dialog</option></Select></Field>
          {f.connection !== 'browser' && <Field label="Bridge"><Select value={f.bridgeId} onChange={(e) => setF({ ...f, bridgeId: e.target.value })}><option value="">Select…</option>{bridges.filter((b) => b.active).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}</Select></Field>}
          {f.connection === 'network' && <><Field label="IP address"><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="192.168.1.50" /></Field><Field label="Port"><Input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field></>}
          <Field label="Paper"><Select value={f.paperWidth} onChange={(e) => setF({ ...f, paperWidth: e.target.value })}><option value="80">80mm</option><option value="58">58mm</option></Select></Field>
        </div>
      </Modal>}
    </div>
  );
}

function Bridges({ bridges }: { bridges: Overview['bridges'] }) {
  const { handleError, toast , prompt } = useFeedback();
  const qc = useQueryClient();
  const [created, setCreated] = useState<null | { token: string; apiUrl: string }>(null);
  return (
    <Card title="Local bridges" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={async () => { const name = await prompt({ title: 'Register bridge', label: 'Bridge name', placeholder: 'e.g. Front till PC', confirmLabel: 'Register', minLength: 2 }); if (name) post<{ token: string; apiUrl: string }>('/integrations/bridges', { name }).then((r) => { setCreated(r); qc.invalidateQueries({ queryKey: ['integrations'] }); }).catch(handleError); }}>Register bridge</Button>}>
      <p className="mb-3 text-sm text-ink-soft">The Chili Bridge runs on a PC on the restaurant LAN. It drives ESC/POS printers and cash drawers, talks to ZKTeco terminals and SecuGen readers, and pushes results to the cloud. See <code>bridge/README.md</code>.</p>
      <DataTable rows={bridges} rowKey={(r) => r._id} columns={[{ key: 'n', header: 'Bridge', render: (r) => <b>{r.name}</b> }, { key: 't', header: 'Token', render: (r) => `cbr_…${r.tokenHint ?? ''}` }, { key: 'v', header: 'Version', render: (r) => r.version ?? '—' }, { key: 's', header: 'Last seen', render: (r) => (r.lastSeenAt ? <span>{dateTime(r.lastSeenAt)} {Date.now() - new Date(r.lastSeenAt).getTime() < 120_000 ? <Pill color="green">online</Pill> : <Pill color="red">offline</Pill>}</span> : <Pill>never</Pill>) }, { key: 'a', header: '', render: (r) => (r.active ? <Button size="sm" variant="ghost" onClick={() => post(`/integrations/bridges/${r._id}/revoke`).then(() => { qc.invalidateQueries({ queryKey: ['integrations'] }); toast('Bridge revoked'); }).catch(handleError)}>Revoke</Button> : <Pill color="red">revoked</Pill>) }]} />
      {created && <Modal open onClose={() => setCreated(null)} title="Bridge token (shown once)"><div className="space-y-3 text-sm"><p>Put these into the bridge’s <code>.env</code>:</p><pre className="overflow-x-auto rounded-xl bg-page p-3 text-xs">CHILI_API_URL={created.apiUrl}{'\n'}CHILI_BRIDGE_TOKEN={created.token}</pre><Button size="sm" variant="secondary" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard?.writeText(created.token)}>Copy token</Button></div></Modal>}
    </Card>
  );
}

function Queue() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [channel, setChannel] = useState('');
  const { data, isLoading } = useQuery<Array<{ _id: string; channel: string; event: string; to: string; status: string; attempts: number; lastError?: string; createdAt: string; providerMessageId?: string }>>({ queryKey: ['notif-jobs', channel], queryFn: () => get('/integrations/notifications/jobs', { channel: channel || undefined }), refetchInterval: 10_000 });
  return (
    <Card title="Notification queue" actions={<Select value={channel} onChange={(e) => setChannel(e.target.value)} className="w-32"><option value="">All</option><option value="sms">SMS</option><option value="email">Email</option></Select>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'd', header: 'Queued', render: (r) => dateTime(r.createdAt) }, { key: 'c', header: 'Channel', render: (r) => r.channel.toUpperCase() }, { key: 'e', header: 'Event', render: (r) => r.event.replace(/_/g, ' ') },
        { key: 't', header: 'To', render: (r) => r.to }, { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> }, { key: 'a', header: 'Attempts', render: (r) => r.attempts },
        { key: 'x', header: 'Detail', render: (r) => <span className="text-xs text-ink-soft">{r.lastError ?? r.providerMessageId}</span> },
        { key: 'r', header: '', render: (r) => ['failed', 'dead'].includes(r.status) && <Button size="sm" variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => post(`/integrations/notifications/jobs/${r._id}/retry`).then(() => { qc.invalidateQueries({ queryKey: ['notif-jobs'] }); toast('Requeued'); }).catch(handleError)}>Retry</Button> },
      ]} />
      <p className="mt-3 text-xs text-ink-soft">“Sent” means the provider accepted the message. Email acceptance by the SMTP server is not proof of inbox delivery; SMS delivery is confirmed only by a delivery report.</p>
    </Card>
  );
}

function Templates() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ event: string; channel: string; custom: boolean; enabled: boolean; subject?: string; body: string; variables: string[]; segments?: { segments: number; encoding: string; length: number }; marketing: boolean }>>({ queryKey: ['templates'], queryFn: () => get('/integrations/notifications/templates') });
  const [edit, setEdit] = useState<null | { event: string; channel: string; subject?: string; body: string; enabled: boolean }>(null);
  return (
    <Card title="Message templates">
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r.event + r.channel} onRowClick={(r) => setEdit({ event: r.event, channel: r.channel, subject: r.subject, body: r.body, enabled: r.enabled })} columns={[
        { key: 'e', header: 'Event', render: (r) => <span className="font-semibold">{r.event.replace(/_/g, ' ')}{r.marketing && <Pill color="yellow" className="ml-2">marketing · opt-in only</Pill>}</span> },
        { key: 'c', header: 'Channel', render: (r) => r.channel.toUpperCase() },
        { key: 'b', header: 'Message', render: (r) => <span className="line-clamp-2 text-xs">{r.body}</span> },
        { key: 's', header: 'Length', render: (r) => (r.segments ? `${r.segments.segments} SMS · ${r.segments.encoding}` : '') },
        { key: 'x', header: '', render: (r) => (r.custom ? <Pill color="blue">custom</Pill> : <Pill>default</Pill>) },
      ]} />
      {edit && <Modal open onClose={() => setEdit(null)} title={`${edit.event.replace(/_/g, ' ')} · ${edit.channel.toUpperCase()}`} footer={<Button onClick={() => put(`/integrations/notifications/templates/${edit.event}/${edit.channel}`, { subject: edit.subject, body: edit.body, enabled: edit.enabled }).then(() => { setEdit(null); qc.invalidateQueries({ queryKey: ['templates'] }); toast('Template saved'); }).catch(handleError)}>Save</Button>}>
        <div className="space-y-3">
          {edit.channel === 'email' && <Field label="Subject"><Input value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>}
          <Field label="Body" hint="Use {{variable}} placeholders, e.g. {{restaurant_name}}, {{order_number}}, {{amount}}"><Textarea className="min-h-[140px]" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
          <Toggle checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" />
        </div>
      </Modal>}
    </Card>
  );
}
