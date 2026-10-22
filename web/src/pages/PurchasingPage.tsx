import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, PackageCheck } from 'lucide-react';
import { get, post } from '@/lib/api';
import { date, money, toCents } from '@/lib/format';
import { Button, Card, DataTable, Field, Input, Modal, PageHeader, Select, StatusPill, Tabs } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Supplier { _id: string; name: string; phone?: string; email?: string; balance: number; paymentTermsDays: number }
interface Ing { _id: string; name: string; baseUnit: string; units: Array<{ name: string }> }
interface PO { _id: string; number: string; supplierId: string; status: string; total: number; createdAt: string; lines: Array<{ ingredientId: string; ingredientName: string; qty: number; unit: string; unitPrice: number; receivedQty: number }> }
type Line = { ingredientId: string; qty: string; unit: string; unitPrice: string; batchNo?: string; expiresAt?: string };

export default function PurchasingPage() {
  const { can } = useAuth();
  const { handleError, toast , prompt } = useFeedback();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'pos' | 'grn' | 'suppliers' | 'invoices'>('pos');
  const suppliers = useQuery<Supplier[]>({ queryKey: ['suppliers'], queryFn: () => get('/inventory/suppliers') });
  const pos = useQuery<PO[]>({ queryKey: ['pos'], queryFn: () => get('/inventory/purchase-orders') });
  const grns = useQuery<Array<{ _id: string; number: string; supplierId: string; total: number; receivedAt: string; supplierInvoiceNo?: string }>>({ queryKey: ['grns'], queryFn: () => get('/inventory/grn'), enabled: tab === 'grn' });
  const invoices = useQuery<Array<{ _id: string; invoiceNo: string; supplierId: string; amount: number; paid: number; dueDate: string; status: string }>>({ queryKey: ['invoices'], queryFn: () => get('/inventory/supplier-invoices'), enabled: tab === 'invoices' });
  const ings = useQuery<Ing[]>({ queryKey: ['ingredients'], queryFn: () => get('/inventory/ingredients') });
  const [modal, setModal] = useState<null | { kind: 'po' } | { kind: 'grn'; po?: PO } | { kind: 'supplier' }>(null);
  const sname = (id: string) => suppliers.data?.find((s) => s._id === id)?.name ?? '—';
  const setStatus = (po: PO, status: string, email = false) => post(`/inventory/purchase-orders/${po._id}/status`, { status, email }).then(() => { qc.invalidateQueries({ queryKey: ['pos'] }); toast(`PO ${status}`); }).catch(handleError);

  return (
    <div>
      <PageHeader title="Purchasing" subtitle="Suppliers, purchase orders, goods received and supplier invoices" actions={
        <>
          {can('procurement.manage') && <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ kind: 'supplier' })}>Supplier</Button>}
          {can('procurement.manage') && <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ kind: 'po' })}>Purchase order</Button>}
          {can('inventory.manage') && <Button icon={<PackageCheck className="h-4 w-4" />} onClick={() => setModal({ kind: 'grn' })}>Receive goods</Button>}
        </>
      } />
      <Tabs tabs={[{ id: 'pos', label: 'Purchase orders' }, { id: 'grn', label: 'Goods received' }, { id: 'suppliers', label: 'Suppliers' }, { id: 'invoices', label: 'Supplier invoices' }]} value={tab} onChange={setTab} />
      <Card>
        {tab === 'pos' && <DataTable rows={pos.data} loading={pos.isLoading} rowKey={(r) => r._id} columns={[
          { key: 'n', header: 'PO', render: (r) => <b>{r.number}</b> }, { key: 's', header: 'Supplier', render: (r) => sname(r.supplierId) }, { key: 'd', header: 'Date', render: (r) => date(r.createdAt) },
          { key: 'l', header: 'Lines', render: (r) => <span className="text-xs">{r.lines.map((l) => `${l.ingredientName} ${l.receivedQty}/${l.qty}${l.unit}`).join(', ')}</span> },
          { key: 't', header: 'Total', render: (r) => money(r.total) }, { key: 'st', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
          { key: 'a', header: '', render: (r) => <div className="flex gap-1">
            {r.status === 'draft' && can('procurement.manage') && <Button size="sm" variant="secondary" onClick={() => setStatus(r, 'submitted')}>Submit</Button>}
            {r.status === 'submitted' && can('procurement.approve') && <Button size="sm" onClick={() => setStatus(r, 'approved', true)}>Approve & email</Button>}
            {['approved', 'partially_received'].includes(r.status) && can('inventory.manage') && <Button size="sm" onClick={() => setModal({ kind: 'grn', po: r })}>Receive</Button>}
          </div> },
        ]} />}
        {tab === 'grn' && <DataTable rows={grns.data} loading={grns.isLoading} rowKey={(r) => r._id} columns={[{ key: 'n', header: 'GRN', render: (r) => r.number }, { key: 's', header: 'Supplier', render: (r) => sname(r.supplierId) }, { key: 'i', header: 'Invoice', render: (r) => r.supplierInvoiceNo ?? '—' }, { key: 'd', header: 'Received', render: (r) => date(r.receivedAt) }, { key: 't', header: 'Total', render: (r) => money(r.total) }]} />}
        {tab === 'suppliers' && <DataTable rows={suppliers.data} loading={suppliers.isLoading} rowKey={(r) => r._id} columns={[{ key: 'n', header: 'Supplier', render: (r) => <b>{r.name}</b> }, { key: 'c', header: 'Contact', render: (r) => <span className="text-xs">{r.phone} {r.email}</span> }, { key: 't', header: 'Terms', render: (r) => `${r.paymentTermsDays} days` }, { key: 'b', header: 'Balance owed', render: (r) => money(r.balance) }]} />}
        {tab === 'invoices' && <DataTable rows={invoices.data} loading={invoices.isLoading} rowKey={(r) => r._id} columns={[
          { key: 'i', header: 'Invoice', render: (r) => r.invoiceNo }, { key: 's', header: 'Supplier', render: (r) => sname(r.supplierId) }, { key: 'd', header: 'Due', render: (r) => date(r.dueDate) },
          { key: 'a', header: 'Amount', render: (r) => money(r.amount) }, { key: 'p', header: 'Paid', render: (r) => money(r.paid) }, { key: 'st', header: 'Status', render: (r) => <StatusPill status={r.status === 'unpaid' ? 'pending' : r.status === 'paid' ? 'paid' : 'partial'} /> },
          { key: 'x', header: '', render: (r) => r.status !== 'paid' && can('expenses.manage') && <Button size="sm" onClick={async () => { const amt = await prompt({ title: 'Pay supplier invoice', label: 'Amount to pay (KSh)', inputMode: 'decimal', defaultValue: String((r.amount - r.paid) / 100), confirmLabel: 'Next' }); if (!amt || Number.isNaN(Number(amt))) return; const ref = await prompt({ title: 'Pay supplier invoice', label: 'Payment reference (optional)', placeholder: 'Bank or M-Pesa reference', confirmLabel: 'Record payment', minLength: 0 }); if (ref === null) return; post(`/inventory/supplier-invoices/${r._id}/pay`, { amount: toCents(amt), method: 'bank', reference: ref || undefined, notify: true }).then(() => { qc.invalidateQueries({ queryKey: ['invoices'] }); qc.invalidateQueries({ queryKey: ['suppliers'] }); toast('Payment recorded'); }).catch(handleError); }}>Pay</Button> },
        ]} />}
      </Card>
      {modal?.kind === 'supplier' && <SupplierModal onClose={() => setModal(null)} />}
      {(modal?.kind === 'po' || modal?.kind === 'grn') && ings.data && suppliers.data && <LinesModal kind={modal.kind} po={modal.kind === 'grn' ? modal.po : undefined} ings={ings.data} suppliers={suppliers.data} onClose={() => setModal(null)} />}
    </div>
  );
}

function SupplierModal({ onClose }: { onClose: () => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', contactName: '', phone: '', email: '', kraPin: '', paymentTermsDays: '30' });
  return (
    <Modal open onClose={onClose} title="New supplier" footer={<Button onClick={() => post('/inventory/suppliers', { ...f, email: f.email || undefined, paymentTermsDays: Number(f.paymentTermsDays) }).then(() => { qc.invalidateQueries({ queryKey: ['suppliers'] }); toast('Supplier added'); onClose(); }).catch(handleError)}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['name', 'contactName', 'phone', 'email', 'kraPin', 'paymentTermsDays'] as const).map((k) => <Field key={k} label={{ name: 'Name', contactName: 'Contact person', phone: 'Phone', email: 'Email', kraPin: 'KRA PIN', paymentTermsDays: 'Payment terms (days)' }[k]}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
      </div>
    </Modal>
  );
}

function LinesModal({ kind, po, ings, suppliers, onClose }: { kind: 'po' | 'grn'; po?: PO; ings: Ing[]; suppliers: Supplier[]; onClose: () => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [supplierId, setSupplier] = useState(po?.supplierId ?? suppliers[0]?._id ?? '');
  const [invoiceNo, setInvoice] = useState('');
  const [lines, setLines] = useState<Line[]>(po ? po.lines.filter((l) => l.receivedQty < l.qty).map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty - l.receivedQty), unit: l.unit, unitPrice: String(l.unitPrice / 100) })) : [{ ingredientId: '', qty: '', unit: '', unitPrice: '' }]);
  const ing = (id: string) => ings.find((i) => i._id === id);
  const upd = (i: number, p: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * toCents(l.unitPrice || 0), 0);
  const submit = () => {
    const payload = lines.filter((l) => l.ingredientId && Number(l.qty) > 0).map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty), unit: l.unit && l.unit !== ing(l.ingredientId)?.baseUnit ? l.unit : undefined, unitPrice: toCents(l.unitPrice || 0), batchNo: l.batchNo || undefined, expiresAt: l.expiresAt || undefined }));
    const req = kind === 'po' ? post('/inventory/purchase-orders', { supplierId, lines: payload }) : post('/inventory/grn', { supplierId, purchaseOrderId: po?._id, supplierInvoiceNo: invoiceNo || undefined, lines: payload });
    req.then(() => { qc.invalidateQueries(); toast(kind === 'po' ? 'Purchase order created' : 'Goods received — stock updated'); onClose(); }).catch(handleError);
  };
  return (
    <Modal open onClose={onClose} title={kind === 'po' ? 'New purchase order' : `Receive goods${po ? ` — ${po.number}` : ''}`} size="xl" footer={<><span className="mr-auto self-center text-sm">Total <b>{money(total)}</b></span><Button onClick={submit}>{kind === 'po' ? 'Create PO' : 'Post to stock'}</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier"><Select value={supplierId} disabled={!!po} onChange={(e) => setSupplier(e.target.value)}>{suppliers.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}</Select></Field>
          {kind === 'grn' && <Field label="Supplier invoice no."><Input value={invoiceNo} onChange={(e) => setInvoice(e.target.value)} /></Field>}
        </div>
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-2 text-xs font-semibold uppercase text-ink-soft"><span>Ingredient</span><span>Qty</span><span>Unit</span><span>Unit price</span>{kind === 'grn' ? <><span>Batch</span><span>Expiry</span></> : <><span /><span /></>}</div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-2">
            <Select value={l.ingredientId} onChange={(e) => upd(i, { ingredientId: e.target.value, unit: '' })}><option value="">Select…</option>{ings.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}</Select>
            <Input inputMode="decimal" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
            <Select value={l.unit} onChange={(e) => upd(i, { unit: e.target.value })}><option value="">{ing(l.ingredientId)?.baseUnit ?? 'unit'}</option>{ing(l.ingredientId)?.baseUnit === 'g' && <option value="kg">kg</option>}{ing(l.ingredientId)?.baseUnit === 'ml' && <option value="l">l</option>}{ing(l.ingredientId)?.units.map((u) => <option key={u.name}>{u.name}</option>)}</Select>
            <Input inputMode="decimal" placeholder="KSh" value={l.unitPrice} onChange={(e) => upd(i, { unitPrice: e.target.value })} />
            {kind === 'grn' ? <><Input value={l.batchNo ?? ''} onChange={(e) => upd(i, { batchNo: e.target.value })} /><Input type="date" value={l.expiresAt ?? ''} onChange={(e) => upd(i, { expiresAt: e.target.value })} /></> : <><span /><span /></>}
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '', unitPrice: '' }])}>Add line</Button>
      </div>
    </Modal>
  );
}
