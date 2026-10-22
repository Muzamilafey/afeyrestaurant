import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ClipboardCheck, ArrowLeftRight, Trash2 } from 'lucide-react';
import { get, post, put } from '@/lib/api';
import { dateTime, money, titleCase } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Textarea } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Ing { _id: string; name: string; kind: string; baseUnit: string; units: Array<{ name: string; factor: number }>; qty: number; value: number; minLevel: number; status: string; containers: number | null; containerSize?: number; isBarItem: boolean; lastCost: number }
type TabId = 'stock' | 'bar' | 'ledger' | 'adjustments' | 'counts' | 'transfers';

export default function InventoryPage() {
  const { can, session, branch } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('stock');
  const ings = useQuery<Ing[]>({ queryKey: ['ingredients'], queryFn: () => get('/inventory/ingredients') });
  const [modal, setModal] = useState<null | 'ingredient' | 'adjust' | 'transfer'>(null);
  const name = (id: string) => ings.data?.find((i) => i._id === id)?.name ?? id;
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['ingredients', 'ledger', 'adjustments', 'counts', 'transfers', 'bar-stock'].includes(q.queryKey[0] as string) });

  return (
    <div>
      <PageHeader title="Inventory" subtitle={`Stock at ${branch?.name}. Every movement is recorded in the ledger.`} actions={
        <>
          {can('inventory.manage') && <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setModal('ingredient')}>Ingredient</Button>}
          {can('inventory.adjust') && <Button variant="secondary" icon={<Trash2 className="h-4 w-4" />} onClick={() => setModal('adjust')}>Wastage / adjustment</Button>}
          {can('inventory.manage') && (session?.branches.length ?? 0) > 1 && <Button variant="secondary" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setModal('transfer')}>Transfer</Button>}
        </>
      } />
      <Tabs<TabId> tabs={[{ id: 'stock', label: 'Stock levels' }, { id: 'bar', label: 'Bar bottles' }, { id: 'ledger', label: 'Ledger' }, { id: 'adjustments', label: 'Adjustments' }, { id: 'counts', label: 'Stock counts' }, { id: 'transfers', label: 'Transfers' }]} value={tab} onChange={setTab} />
      {tab === 'stock' && (
        <Card>
          <DataTable rows={ings.data} loading={ings.isLoading} rowKey={(r) => r._id} columns={[
            { key: 'n', header: 'Ingredient', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{titleCase(r.kind)}</p></div> },
            { key: 'q', header: 'On hand', render: (r) => <span className="font-semibold">{Math.round(r.qty * 100) / 100} {r.baseUnit}</span> },
            { key: 'c', header: 'Containers', render: (r) => (r.containers !== null ? `${r.containers}` : '—') },
            { key: 'm', header: 'Min level', render: (r) => `${r.minLevel} ${r.baseUnit}` },
            { key: 'v', header: 'Value', render: (r) => money(r.value) },
            { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
          ]} />
        </Card>
      )}
      {tab === 'bar' && <BarStock />}
      {tab === 'ledger' && <Ledger name={name} />}
      {tab === 'adjustments' && <Adjustments name={name} />}
      {tab === 'counts' && <Counts />}
      {tab === 'transfers' && <Transfers name={name} />}

      {modal === 'ingredient' && <IngredientModal onClose={() => setModal(null)} onSaved={() => { refresh(); setModal(null); toast('Ingredient saved'); }} />}
      {modal === 'adjust' && ings.data && <AdjustModal ings={ings.data} onClose={() => setModal(null)} onSaved={() => { refresh(); setModal(null); toast('Adjustment submitted for approval'); }} />}
      {modal === 'transfer' && ings.data && (
        <TransferModal ings={ings.data} branches={(session?.branches ?? []).filter((b) => b.id !== branch?.id)} onClose={() => setModal(null)} onSaved={() => { refresh(); setModal(null); toast('Transfer dispatched'); }} onError={handleError} />
      )}
    </div>
  );
}

function BarStock() {
  const { data, isLoading } = useQuery<Array<{ id: string; name: string; baseUnit: string; qty: number; containerSize: number; fullContainers: number | null; openContainerRemaining: number | null; low: boolean }>>({ queryKey: ['bar-stock'], queryFn: () => get('/inventory/bar-stock') });
  return (
    <Card>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r.id} columns={[
        { key: 'n', header: 'Item', render: (r) => <b>{r.name}</b> },
        { key: 'f', header: 'Full bottles/kegs', render: (r) => r.fullContainers ?? '—' },
        { key: 'o', header: 'Open container', render: (r) => (r.openContainerRemaining !== null ? `${r.openContainerRemaining} ${r.baseUnit} of ${r.containerSize}` : '—') },
        { key: 'q', header: 'Total', render: (r) => `${r.qty} ${r.baseUnit}` },
        { key: 's', header: '', render: (r) => (r.low ? <Pill color="yellow">Low</Pill> : null) },
      ]} />
    </Card>
  );
}

function Ledger({ name }: { name: (id: string) => string }) {
  const { data, isLoading } = useQuery<Array<{ _id: string; createdAt: string; ingredientId: string; type: string; qty: number; totalCost: number; balanceAfter: number; reason?: string; refType?: string }>>({ queryKey: ['ledger'], queryFn: () => get('/inventory/ledger') });
  return (
    <Card>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) },
        { key: 'i', header: 'Ingredient', render: (r) => name(r.ingredientId) },
        { key: 't', header: 'Type', render: (r) => <Pill color={r.qty > 0 ? 'green' : 'gray'}>{titleCase(r.type)}</Pill> },
        { key: 'q', header: 'Qty', render: (r) => <span className={r.qty < 0 ? 'text-danger' : 'text-brand-dark'}>{r.qty > 0 ? '+' : ''}{Math.round(r.qty * 100) / 100}</span> },
        { key: 'c', header: 'Cost', render: (r) => money(Math.round(r.totalCost)) },
        { key: 'b', header: 'Balance', render: (r) => Math.round(r.balanceAfter * 100) / 100 },
        { key: 'r', header: 'Ref', render: (r) => <span className="text-xs text-ink-soft">{r.reason ?? r.refType}</span> },
      ]} />
    </Card>
  );
}

function Adjustments({ name }: { name: (id: string) => string }) {
  const { can, session } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; createdAt: string; type: string; reason: string; status: string; requestedBy: string; lines: Array<{ ingredientId: string; qty: number; unit?: string }> }>>({ queryKey: ['adjustments'], queryFn: () => get('/inventory/adjustments') });
  const decide = (id: string, approve: boolean) => post(`/inventory/adjustments/${id}/decision`, { approve }).then(() => { qc.invalidateQueries({ queryKey: ['adjustments'] }); qc.invalidateQueries({ queryKey: ['ingredients'] }); toast(approve ? 'Approved and posted to the ledger' : 'Rejected'); }).catch(handleError);
  return (
    <Card>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'd', header: 'Requested', render: (r) => dateTime(r.createdAt) },
        { key: 't', header: 'Type', render: (r) => titleCase(r.type) },
        { key: 'l', header: 'Items', render: (r) => r.lines.map((l) => `${name(l.ingredientId)} ${l.qty}${l.unit ?? ''}`).join(', ') },
        { key: 'r', header: 'Reason', render: (r) => r.reason },
        { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
        { key: 'a', header: '', render: (r) => r.status === 'pending' && can('inventory.adjust_approve') && r.requestedBy !== session?.user.id ? <div className="flex gap-1"><Button size="sm" onClick={() => decide(r._id, true)}>Approve</Button><Button size="sm" variant="ghost" onClick={() => decide(r._id, false)}>Reject</Button></div> : null },
      ]} />
    </Card>
  );
}

function Counts() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; name: string; status: string; createdAt: string; lines: Array<{ ingredientId: string; ingredientName: string; expectedQty: number; countedQty?: number; variance?: number }> }>>({ queryKey: ['counts'], queryFn: () => get('/inventory/counts') });
  const [open, setOpen] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const current = data?.find((c) => c._id === open);
  return (
    <Card actions={can('inventory.manage') && <Button size="sm" icon={<ClipboardCheck className="h-4 w-4" />} onClick={() => post('/inventory/counts', {}).then(() => qc.invalidateQueries({ queryKey: ['counts'] })).catch(handleError)}>Start count</Button>} title="Physical stock counts">
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} onRowClick={(r) => { setOpen(r._id); setVals({}); }} columns={[
        { key: 'n', header: 'Count', render: (r) => r.name },
        { key: 'd', header: 'Started', render: (r) => dateTime(r.createdAt) },
        { key: 'v', header: 'Variances', render: (r) => r.lines.filter((l) => l.variance).length },
        { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
      ]} />
      {current && (
        <Modal open onClose={() => setOpen(null)} title={current.name} size="lg" footer={current.status !== 'posted' && (
          <>
            <Button variant="secondary" onClick={() => put(`/inventory/counts/${current._id}`, { lines: Object.entries(vals).filter(([, v]) => v !== '').map(([ingredientId, v]) => ({ ingredientId, countedQty: Number(v) })) }).then(() => { qc.invalidateQueries({ queryKey: ['counts'] }); toast('Counts saved'); }).catch(handleError)}>Save counts</Button>
            {current.status === 'submitted' && can('inventory.adjust_approve') && <Button onClick={() => post(`/inventory/counts/${current._id}/post`).then(() => { qc.invalidateQueries(); setOpen(null); toast('Variances posted'); }).catch(handleError)}>Post variances</Button>}
          </>
        )}>
          <table className="table-base">
            <thead><tr><th>Ingredient</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead>
            <tbody>
              {current.lines.map((l) => (
                <tr key={l.ingredientId}>
                  <td>{l.ingredientName}</td>
                  <td>{Math.round(l.expectedQty * 100) / 100}</td>
                  <td>{current.status === 'posted' ? l.countedQty : <Input className="h-9 w-28" inputMode="decimal" value={vals[l.ingredientId] ?? (l.countedQty ?? '')} onChange={(e) => setVals({ ...vals, [l.ingredientId]: e.target.value })} />}</td>
                  <td className={(l.variance ?? 0) < 0 ? 'text-danger' : ''}>{l.variance ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </Card>
  );
}

function Transfers({ name }: { name: (id: string) => string }) {
  const { branch, session } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; number: string; fromBranchId: string; toBranchId: string; status: string; createdAt: string; lines: Array<{ ingredientId: string; qty: number }> }>>({ queryKey: ['transfers'], queryFn: () => get('/inventory/transfers') });
  const bname = (id: string) => session?.branches.find((b) => b.id === id)?.name ?? 'Other branch';
  return (
    <Card>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[
        { key: 'n', header: 'Transfer', render: (r) => r.number },
        { key: 'f', header: 'From → To', render: (r) => `${bname(r.fromBranchId)} → ${bname(r.toBranchId)}` },
        { key: 'l', header: 'Items', render: (r) => r.lines.map((l) => `${name(l.ingredientId)} ${l.qty}`).join(', ') },
        { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
        { key: 'a', header: '', render: (r) => r.status === 'dispatched' && r.toBranchId === branch?.id ? <Button size="sm" onClick={() => post(`/inventory/transfers/${r._id}/receive`).then(() => { qc.invalidateQueries(); toast('Transfer received'); }).catch(handleError)}>Receive</Button> : null },
      ]} />
    </Card>
  );
}

function IngredientModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { handleError } = useFeedback();
  const [f, setF] = useState({ name: '', kind: 'raw', baseUnit: 'g', minLevel: '0', containerSize: '', isBarItem: false, unitName: '', unitFactor: '' });
  return (
    <Modal open onClose={onClose} title="New ingredient" footer={<Button onClick={() => post('/inventory/ingredients', { name: f.name, kind: f.kind, baseUnit: f.baseUnit, minLevel: Number(f.minLevel), containerSize: f.containerSize ? Number(f.containerSize) : undefined, isBarItem: f.isBarItem, units: f.unitName ? [{ name: f.unitName, factor: Number(f.unitFactor) }] : [] }).then(onSaved).catch(handleError)}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, isBarItem: ['spirit', 'beer', 'wine', 'mixer', 'packaged_beverage'].includes(e.target.value) })}>{['raw', 'finished', 'packaged_beverage', 'spirit', 'beer', 'wine', 'mixer', 'packaging', 'other'].map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}</Select></Field>
        <Field label="Base unit" hint="Stock is tracked in this unit"><Select value={f.baseUnit} onChange={(e) => setF({ ...f, baseUnit: e.target.value })}><option value="g">grams (g)</option><option value="ml">millilitres (ml)</option><option value="pcs">pieces</option></Select></Field>
        <Field label="Minimum level"><Input inputMode="decimal" value={f.minLevel} onChange={(e) => setF({ ...f, minLevel: e.target.value })} /></Field>
        <Field label="Container size (bottle/keg)" hint="In base units, e.g. 750"><Input inputMode="decimal" value={f.containerSize} onChange={(e) => setF({ ...f, containerSize: e.target.value })} /></Field>
        <Field label="Extra unit name" hint="e.g. bottle, crate, shot"><Input value={f.unitName} onChange={(e) => setF({ ...f, unitName: e.target.value })} /></Field>
        <Field label="Base units per extra unit"><Input inputMode="decimal" value={f.unitFactor} onChange={(e) => setF({ ...f, unitFactor: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function AdjustModal({ ings, onClose, onSaved }: { ings: Ing[]; onClose: () => void; onSaved: () => void }) {
  const { handleError } = useFeedback();
  const [type, setType] = useState('wastage');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([{ ingredientId: '', qty: '', unit: '' }]);
  const ing = (id: string) => ings.find((i) => i._id === id);
  return (
    <Modal open onClose={onClose} title="Stock adjustment" size="lg" footer={<Button disabled={reason.length < 3} onClick={() => post('/inventory/adjustments', { type, reason, lines: lines.filter((l) => l.ingredientId && l.qty).map((l) => ({ ingredientId: l.ingredientId, qty: (type === 'adjustment' ? 1 : -1) * Math.abs(Number(l.qty)), unit: l.unit || undefined })) }).then(onSaved).catch(handleError)}>Submit for approval</Button>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{['wastage', 'breakage', 'spoilage', 'complimentary', 'adjustment'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
            <Select value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}><option value="">Ingredient…</option>{ings.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}</Select>
            <Input placeholder={type === 'adjustment' ? '± qty' : 'qty'} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <Select value={l.unit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}><option value="">{ing(l.ingredientId)?.baseUnit ?? 'unit'}</option>{ing(l.ingredientId)?.units.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}</Select>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '' }])}>Add line</Button>
        <p className="text-xs text-ink-soft">Adjustments post to the ledger only after another authorised person approves them.</p>
      </div>
    </Modal>
  );
}

function TransferModal({ ings, branches, onClose, onSaved, onError }: { ings: Ing[]; branches: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [to, setTo] = useState(branches[0]?.id ?? '');
  const [lines, setLines] = useState([{ ingredientId: '', qty: '' }]);
  const [notes, setNotes] = useState('');
  return (
    <Modal open onClose={onClose} title="Transfer stock" footer={<Button onClick={() => post('/inventory/transfers', { toBranchId: to, notes: notes || undefined, lines: lines.filter((l) => l.ingredientId && l.qty).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty) })) }).then(onSaved).catch(onError)}>Dispatch</Button>}>
      <div className="space-y-3">
        <Field label="To branch"><Select value={to} onChange={(e) => setTo(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr] gap-2">
            <Select value={l.ingredientId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}><option value="">Ingredient…</option>{ings.map((x) => <option key={x._id} value={x._id}>{x.name} ({x.baseUnit})</option>)}</Select>
            <Input inputMode="decimal" placeholder="qty (base unit)" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { ingredientId: '', qty: '' }])}>Add line</Button>
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
