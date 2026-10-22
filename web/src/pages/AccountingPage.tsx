import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Unlock, ArrowDownToLine, Plus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { date, dateTime, money, titleCase, toCents } from '@/lib/format';
import { Button, Card, DataTable, Empty, Field, Input, Modal, PageHeader, Pill, Select, Stat, StatusPill, Tabs, Skeleton, ErrorBox } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

type TabId = 'drawer' | 'sessions' | 'expenses' | 'pnl' | 'reconciliation' | 'tax';

export default function AccountingPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<TabId>(can('cash.session') ? 'drawer' : 'pnl');
  return (
    <div>
      <PageHeader title="Accounting" subtitle="Cash drawers, expenses, reconciliation and profit & loss" />
      <Tabs<TabId> tabs={[
        { id: 'drawer', label: 'My cash drawer', hidden: !can('cash.session') },
        { id: 'sessions', label: 'Cash sessions', hidden: !can('cash.session_view_all') },
        { id: 'expenses', label: 'Expenses', hidden: !can('expenses.manage', 'accounting.view') },
        { id: 'reconciliation', label: 'Reconciliation', hidden: !can('reports.financial', 'accounting.view') },
        { id: 'pnl', label: 'Profit & loss', hidden: !can('reports.financial') },
        { id: 'tax', label: 'Tax', hidden: !can('reports.financial') },
      ]} value={tab} onChange={setTab} />
      {tab === 'drawer' && <Drawer />}
      {tab === 'sessions' && <Sessions />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'reconciliation' && <Reconciliation />}
      {tab === 'pnl' && <PnL />}
      {tab === 'tax' && <Tax />}
    </div>
  );
}

const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

function Drawer() {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<null | { _id: string; openedAt: string; openingFloat: number; expected: number; totals: Record<string, number>; movements: Array<{ _id: string; type: string; amount: number; reason: string; createdAt: string }> }>({ queryKey: ['cash-session'], queryFn: () => get('/cash/session'), refetchInterval: 30_000 });
  const [float, setFloat] = useState('');
  const [move, setMove] = useState<null | { type: string; amount: string; reason: string }>(null);
  const [counted, setCounted] = useState('');
  const [closing, setClosing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['cash-session'] });
  if (isLoading) return <Skeleton className="h-48" />;
  if (!data)
    return (
      <Card title="Open cash drawer">
        <div className="flex max-w-md items-end gap-2">
          <Field label="Opening float (KSh)" className="flex-1"><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
          <Button icon={<Unlock className="h-4 w-4" />} onClick={() => post('/cash/session/open', { openingFloat: toCents(float || 0) }).then(() => { refresh(); toast('Drawer opened'); }).catch(handleError)}>Open drawer</Button>
        </div>
      </Card>
    );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Expected cash in drawer" value={money(data.expected)} hint={`Opened ${dateTime(data.openedAt)}`} />
        <Stat label="Cash sales" value={money(data.totals.cashSales)} hint={`Float ${money(data.openingFloat)}`} />
        <Stat label="M-Pesa" value={money(data.totals.mpesa)} />
        <Stat label="Card / QR" value={money(data.totals.card)} />
      </div>
      <Card title="Drawer movements" actions={<>
        <Button size="sm" variant="secondary" icon={<ArrowDownToLine className="h-4 w-4" />} onClick={() => setMove({ type: 'drop', amount: '', reason: 'Cash drop to safe' })}>Cash drop</Button>
        <Button size="sm" variant="secondary" onClick={() => setMove({ type: 'expense', amount: '', reason: '' })}>Petty expense</Button>
        <Button size="sm" variant="secondary" onClick={() => setMove({ type: 'pay_in', amount: '', reason: '' })}>Pay in</Button>
        <Button size="sm" icon={<Lock className="h-4 w-4" />} onClick={() => setClosing(true)}>Close drawer</Button>
      </>}>
        <DataTable rows={data.movements} rowKey={(r) => r._id} empty={<Empty title="No drops or expenses yet" />} columns={[{ key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) }, { key: 't', header: 'Type', render: (r) => titleCase(r.type) }, { key: 'a', header: 'Amount', render: (r) => money(r.amount) }, { key: 'r', header: 'Reason', render: (r) => r.reason }]} />
      </Card>
      {move && <Modal open onClose={() => setMove(null)} title={titleCase(move.type)} footer={<Button disabled={!move.amount || move.reason.length < 3} onClick={() => post('/cash/session/movement', { type: move.type, amount: toCents(move.amount), reason: move.reason }).then(() => { setMove(null); refresh(); toast('Recorded'); }).catch(handleError)}>Save</Button>}>
        <div className="space-y-3"><Field label="Amount (KSh)"><Input inputMode="decimal" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} /></Field><Field label="Reason"><Input value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field></div>
      </Modal>}
      {closing && <Modal open onClose={() => setClosing(false)} title="Close cash drawer" footer={<Button disabled={counted === ''} onClick={() => post<{ variance: number }>('/cash/session/close', { countedCash: toCents(counted) }).then((s) => { setClosing(false); refresh(); toast(`Drawer closed. Variance ${money(s.variance)}`, s.variance === 0 ? 'success' : 'info'); }).catch(handleError)}>Close drawer</Button>}>
        <div className="space-y-3"><p className="text-sm text-ink-soft">Count the cash in the drawer and enter the total. The expected amount is shown after closing to avoid bias.</p><Field label="Counted cash (KSh)"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} className="h-12 text-lg" /></Field></div>
      </Modal>}
    </div>
  );
}

function Sessions() {
  const { data, isLoading } = useQuery<Array<{ _id: string; userName: string; status: string; openedAt: string; closedAt?: string; openingFloat: number; expectedCash?: number; countedCash?: number; variance?: number }>>({ queryKey: ['cash-sessions'], queryFn: () => get('/cash/sessions') });
  return <Card><DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'u', header: 'Cashier', render: (r) => r.userName }, { key: 'o', header: 'Opened', render: (r) => dateTime(r.openedAt) }, { key: 'c', header: 'Closed', render: (r) => dateTime(r.closedAt) }, { key: 'f', header: 'Float', render: (r) => money(r.openingFloat) }, { key: 'e', header: 'Expected', render: (r) => (r.expectedCash !== undefined ? money(r.expectedCash) : '—') }, { key: 'n', header: 'Counted', render: (r) => (r.countedCash !== undefined ? money(r.countedCash) : '—') }, { key: 'v', header: 'Variance', render: (r) => (r.variance !== undefined ? <Pill color={r.variance === 0 ? 'green' : Math.abs(r.variance) > 50000 ? 'red' : 'yellow'}>{money(r.variance)}</Pill> : '—') }, { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> }]} /></Card>;
}

function Expenses() {
  const { can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Array<{ _id: string; date: string; category: string; description?: string; amount: number; paidFrom: string; reversedBy?: string; reversalOf?: string }>>({ queryKey: ['expenses'], queryFn: () => get('/cash/expenses', { from: monthStart() }) });
  const [f, setF] = useState<null | { category: string; description: string; amount: string; paidFrom: string; reference: string }>(null);
  return (
    <Card title="Expenses this month" actions={can('expenses.manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setF({ category: '', description: '', amount: '', paidFrom: 'mpesa', reference: '' })}>Expense</Button>}>
      <DataTable rows={data} loading={isLoading} rowKey={(r) => r._id} columns={[{ key: 'd', header: 'Date', render: (r) => date(r.date) }, { key: 'c', header: 'Category', render: (r) => r.category }, { key: 'x', header: 'Description', render: (r) => r.description }, { key: 'p', header: 'Paid from', render: (r) => titleCase(r.paidFrom) }, { key: 'a', header: 'Amount', render: (r) => <span className={r.amount < 0 ? 'text-danger' : ''}>{money(r.amount)}</span> }, { key: 'r', header: '', render: (r) => (r.reversedBy ? <Pill>Reversed</Pill> : !r.reversalOf && can('expenses.manage') ? <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Reason for reversal'); if (reason) post(`/cash/expenses/${r._id}/reverse`, { reason }).then(() => qc.invalidateQueries({ queryKey: ['expenses'] })).catch(handleError); }}>Reverse</Button> : null) }]} />
      {f && <Modal open onClose={() => setF(null)} title="Record expense" footer={<Button onClick={() => post('/cash/expenses', { category: f.category, description: f.description || undefined, amount: toCents(f.amount), paidFrom: f.paidFrom, reference: f.reference || undefined }).then(() => { setF(null); qc.invalidateQueries({ queryKey: ['expenses'] }); toast('Expense recorded'); }).catch(handleError)}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Category"><Input list="exp-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="exp-cats">{['Rent', 'Utilities', 'Salaries', 'Gas', 'Repairs', 'Marketing', 'Transport', 'Licences', 'Other'].map((c) => <option key={c} value={c} />)}</datalist></Field><Field label="Amount (KSh)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field><Field label="Paid from"><Select value={f.paidFrom} onChange={(e) => setF({ ...f, paidFrom: e.target.value })}><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="petty_cash">Petty cash</option><option value="other">Other</option></Select></Field><Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field><Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
      </Modal>}
    </Card>
  );
}

function Reconciliation() {
  const { data, isLoading, error } = useQuery<{ byMethod: Array<{ _id: { method: string; verification: string }; amount: number; refunded: number; count: number }>; mpesaAttempts: Array<{ _id: string; amount: number; count: number }>; c2b: Array<{ _id: string; amount: number; count: number }>; splitPaymentOrders: number; offlineCash: { amount: number; count: number }; mpesaIssues: Array<{ _id: string; createdAt: string; amount: number; status: string; error?: string; resultDesc?: string; phone?: string }> }>({ queryKey: ['reconciliation'], queryFn: () => get('/reports/reconciliation', { from: monthStart() }) });
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3"><Stat label="Split-payment orders" value={data.splitPaymentOrders} /><Stat label="Offline cash (pending verification)" value={money(data.offlineCash.amount)} hint={`${data.offlineCash.count} payments`} tone="yellow" /><Stat label="M-Pesa issues" value={data.mpesaIssues.length} tone={data.mpesaIssues.length ? 'red' : 'default'} /></div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Collections by method & verification (month to date)"><DataTable rows={data.byMethod} rowKey={(r) => r._id.method + r._id.verification} columns={[{ key: 'm', header: 'Method', render: (r) => (r._id.method === 'mpesa' ? 'M-Pesa' : titleCase(r._id.method)) }, { key: 'v', header: 'Verification', render: (r) => <Pill color={r._id.verification === 'provider' || r._id.verification === 'cash' ? 'green' : 'yellow'}>{titleCase(r._id.verification)}</Pill> }, { key: 'c', header: 'Count', render: (r) => r.count }, { key: 'a', header: 'Amount', render: (r) => money(r.amount) }, { key: 'r', header: 'Refunded', render: (r) => money(r.refunded) }]} /></Card>
        <Card title="M-Pesa STK attempts"><DataTable rows={data.mpesaAttempts} rowKey={(r) => r._id} columns={[{ key: 's', header: 'Status', render: (r) => <StatusPill status={r._id} /> }, { key: 'c', header: 'Count', render: (r) => r.count }, { key: 'a', header: 'Amount', render: (r) => money(r.amount) }]} /></Card>
      </div>
      <Card title="M-Pesa exceptions to investigate"><DataTable rows={data.mpesaIssues} rowKey={(r) => r._id} empty={<Empty title="No exceptions" />} columns={[{ key: 'd', header: 'When', render: (r) => dateTime(r.createdAt) }, { key: 'a', header: 'Amount', render: (r) => money(r.amount) }, { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> }, { key: 'e', header: 'Detail', render: (r) => <span className="text-xs">{r.error ?? r.resultDesc}</span> }]} /></Card>
    </div>
  );
}

function PnL() {
  const { data, isLoading, error } = useQuery<{ revenue: Record<string, number>; costOfSales: { cogs: number; shrinkage: number; foodCostPct: number | null }; grossProfit: number; grossMarginPct: number | null; expenses: { total: number; byCategory: Array<{ _id: string; amount: number }> }; operatingProfit: number; purchases: Array<{ supplier?: string; amount: number }>; note: string }>({ queryKey: ['pnl'], queryFn: () => get('/reports/profit-loss', { from: monthStart() }) });
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-60" />;
  const line = (label: string, v: number, bold = false, neg = false) => <div className={`flex justify-between py-1.5 ${bold ? 'border-t border-line font-bold' : ''}`}><span>{label}</span><span>{neg ? '− ' : ''}{money(Math.round(v))}</span></div>;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title="Profit & loss — month to date" className="xl:col-span-2">
        <div className="text-sm">
          {line('Gross sales (incl. tax)', data.revenue.grossSales)}
          {line('Less tax collected', data.revenue.tax, false, true)}
          {line('Less refunds', data.revenue.refunds, false, true)}
          {line('Net sales', data.revenue.netSales, true)}
          {line('Cost of goods sold', data.costOfSales.cogs, false, true)}
          {line('Shrinkage (wastage & count variance)', data.costOfSales.shrinkage, false, true)}
          {line(`Gross profit (${data.grossMarginPct ?? 0}% margin)`, data.grossProfit, true)}
          {data.expenses.byCategory.map((e) => <div key={e._id}>{line(e._id, e.amount, false, true)}</div>)}
          {line('Operating profit', data.operatingProfit, true)}
        </div>
        <p className="mt-3 text-xs text-ink-soft">{data.note} Food cost: {data.costOfSales.foodCostPct ?? 0}% of net sales. Service charge {money(data.revenue.serviceCharge)} and discounts {money(data.revenue.discounts)} are included in gross sales.</p>
      </Card>
      <Card title="Supplier purchases"><DataTable rows={data.purchases} rowKey={(r) => r.supplier ?? '-'} columns={[{ key: 's', header: 'Supplier', render: (r) => r.supplier }, { key: 'a', header: 'Amount', render: (r) => money(r.amount) }]} /></Card>
    </div>
  );
}

function Tax() {
  const { data, isLoading } = useQuery<Array<{ _id: { code: string; rate: number; inclusive: boolean }; amount: number; orders: number }>>({ queryKey: ['tax'], queryFn: () => get('/reports/tax', { from: monthStart() }) });
  return <Card title="Sales tax — month to date"><DataTable rows={data} loading={isLoading} rowKey={(r) => r._id.code} columns={[{ key: 'c', header: 'Tax', render: (r) => r._id.code }, { key: 'r', header: 'Rate', render: (r) => `${r._id.rate / 100}%` }, { key: 'i', header: 'Inclusive', render: (r) => (r._id.inclusive ? 'Yes' : 'No') }, { key: 'o', header: 'Orders', render: (r) => r.orders }, { key: 'a', header: 'Tax amount', render: (r) => money(r.amount) }]} /></Card>;
}
