import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, Printer, Send } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { printReceipt, type ReceiptDoc } from '@/lib/printing';
import { Button, Card, ErrorBox, Input, Pill, Skeleton, Stat } from '@/components/ui';
import { ReceiptPaper } from '@/components/ReceiptPaper';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Z {
  date: string; business: string; branches: string[];
  sales: { gross: number; net: number; orders: number; average: number; discounts: number; tax: number; refunds: number; voids: { count: number; value: number } };
  payments: Array<{ label: string; amount: number; count: number }>;
  tips: { cash: number; mpesa: number; total: number };
  drawers: Array<{ who: string; status: string; expected: number; counted: number | null; variance: number | null }>;
  attention: { openOrders: number; openValue: number; unconfirmedMpesa: number; manualMpesa: number };
}
interface Resp { report: Z; closed: { closedAt: string; closedByName?: string; timesClosed: number } | null; doc: ReceiptDoc }

const today = () => new Date().toLocaleDateString('en-CA');

/** End of day: figures so far (X), close the day (Z), print it and send it to the owner. */
export function EndOfDay({ branchId }: { branchId?: string }) {
  const { can } = useAuth();
  const { toast, handleError, confirm } = useFeedback();
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [live, setLive] = useState(false);
  const q = { date, branchId, live: live ? '1' : undefined };
  const { data, isLoading, error, refetch } = useQuery<Resp>({ queryKey: ['day-close', q], queryFn: () => get('/day-close', q) });
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <ErrorBox error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) return <div className="grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  const z = data.report;
  const warnings = [
    z.attention.openOrders ? `${z.attention.openOrders} order(s) still open — ${money(z.attention.openValue)} unpaid` : null,
    z.drawers.some((d) => d.status === 'open') ? 'A cash drawer is still open — count and close it first' : null,
    z.attention.unconfirmedMpesa ? `${z.attention.unconfirmedMpesa} offline M-Pesa code(s) not confirmed yet` : null,
    z.attention.manualMpesa ? `${z.attention.manualMpesa} manual M-Pesa payment(s) — check them on the M-Pesa statement` : null,
  ].filter(Boolean) as string[];

  async function close() {
    const c = await confirm({
      title: data!.closed ? `Close ${date} again?` : `Close the day ${date}?`,
      message: <>The figures are stored as the Z report for this day{warnings.length ? <> — note: {warnings.join('; ')}.</> : '.'} {data!.closed ? 'This records a new version (audited).' : ''}</>,
      confirmLabel: 'Close the day',
      danger: warnings.length > 0,
    });
    if (!c.ok) return;
    setBusy('close');
    try {
      const r = await post<Resp>('/day-close/close', { date, branchId });
      setLive(false);
      qc.setQueryData(['day-close', { date, branchId, live: undefined }], r);
      toast(`Day ${date} closed`);
      printReceipt(r.doc, `Z report ${date}`);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }
  async function send() {
    setBusy('send');
    try {
      const r = await post<{ sent: string[] }>('/day-close/send', { date, branchId, channel: 'both' });
      toast(`Sent to ${r.sent.join(', ')}`);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={date} max={today()} onChange={(e) => { setDate(e.target.value || today()); setLive(false); }} className="w-44" aria-label="Business day" />
        {data.closed ? <Pill color="green"><Lock className="mr-1 inline h-3 w-3" />Closed {dateTime(data.closed.closedAt)} by {data.closed.closedByName}{data.closed.timesClosed > 1 ? ` · v${data.closed.timesClosed}` : ''}</Pill> : <Pill color="yellow">Not closed — figures so far (X report)</Pill>}
        {data.closed && <button className="text-xs font-semibold text-ink-soft underline" onClick={() => setLive(!live)}>{live ? 'Show the closed figures' : 'Compare with current figures'}</button>}
        <div className="flex-1" />
        <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => printReceipt(data.doc, `${data.closed && !live ? 'Z' : 'X'} report ${date}`)}>Print</Button>
        <Button variant="secondary" icon={<Send className="h-4 w-4" />} loading={busy === 'send'} onClick={send}>Send to owner</Button>
        {can('cash.session_view_all') && <Button icon={<CheckCircle2 className="h-4 w-4" />} loading={busy === 'close'} onClick={close}>{data.closed ? 'Close again' : 'Close the day'}</Button>}
      </div>
      {warnings.length > 0 && (
        <div className="space-y-1 rounded-2xl bg-warn-pale p-3 text-sm text-warn-ink">
          {warnings.map((w) => <p key={w} className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" /> {w}</p>)}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Gross sales" value={money(z.sales.gross)} hint={`Net ${money(z.sales.net)} · tax ${money(z.sales.tax)}`} />
        <Stat label="Orders" value={z.sales.orders} hint={`Average ${money(z.sales.average)}`} />
        <Stat label="Discounts · voids" value={money(z.sales.discounts)} hint={`${z.sales.voids.count} voids (${money(z.sales.voids.value)}) · refunds ${money(z.sales.refunds)}`} tone="yellow" />
        <Stat label="Tips (not in sales)" value={money(z.tips.total)} hint={`Cash ${money(z.tips.cash)} · M-Pesa ${money(z.tips.mpesa)}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card title="Payments">
            <div className="divide-y divide-line text-sm">
              {z.payments.length ? z.payments.map((p) => <div key={p.label} className="flex justify-between py-2"><span>{p.label} <span className="text-ink-soft">({p.count})</span></span><b className="tabular-nums">{money(p.amount)}</b></div>) : <p className="py-2 text-ink-soft">No payments</p>}
            </div>
          </Card>
          <Card title="Cash drawers">
            <div className="divide-y divide-line text-sm">
              {z.drawers.length ? z.drawers.map((d, i) => (
                <div key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{d.who} {d.status === 'open' && <Pill color="yellow">open</Pill>}</span>
                  <span className="tabular-nums">Expected <b>{money(d.expected)}</b>{d.counted !== null && <> · counted <b>{money(d.counted)}</b></>}{d.variance !== null && d.variance !== 0 && <Pill color={d.variance < 0 ? 'red' : 'green'} className="ml-2">{d.variance > 0 ? '+' : ''}{money(d.variance)}</Pill>}</span>
                </div>
              )) : <p className="py-2 text-ink-soft">No drawers were used</p>}
            </div>
          </Card>
        </div>
        <div><ReceiptPaper doc={data.doc} /></div>
      </div>
    </div>
  );
}
