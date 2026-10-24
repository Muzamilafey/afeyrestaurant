import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Smartphone, CheckCircle2, Loader2, Printer, MessageSquare, Mail, XCircle, FlaskConical } from 'lucide-react';
import { Button, Field, Input, Modal, Pill, Select, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { api, get, post } from '@/lib/api';
import { money, toCents, uuid, fromCents } from '@/lib/format';
import { printReceipt, type ReceiptDoc } from '@/lib/printing';
import { ReceiptPaper } from '@/components/ReceiptPaper';
import { pickReceiptPrinter } from '@/lib/till';
import { useAuth } from '@/auth/AuthContext';
import type { Order } from './types';

type Method = 'cash' | 'mpesa' | 'card' | 'account' | 'mpesa_manual';
interface Attempt { _id: string; status: string; resultDesc?: string; mpesaReceipt?: string; provider: string; error?: string }

export function PaymentDialog({ order, onClose, onPaid }: { order: Order; onClose: () => void; onPaid: (o: Order) => void }) {
  const { can } = useAuth();
  const { toast, handleError, withApproval } = useFeedback();
  const qc = useQueryClient();
  const balance = order.totals.total - order.totals.paid;
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState(fromCents(balance));
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState(order.customerPhone ? `0${order.customerPhone.slice(3)}` : '');
  const [customerId, setCustomerId] = useState(order.customerId ?? '');
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [paidOrder, setPaidOrder] = useState<Order | null>(order.status === 'paid' ? order : null);
  const [idemKey, setIdemKey] = useState(uuid());

  useEffect(() => setAmount(fromCents(balance)), [balance]);
  const cents = toCents(amount || 0);
  const tenderedCents = tendered ? toCents(tendered) : cents;

  const { data: attempt } = useQuery<Attempt>({
    queryKey: ['attempt', attemptId],
    queryFn: () => get(`/orders/${order._id}/mpesa/${attemptId}`),
    enabled: !!attemptId,
    refetchInterval: (q) => (['pending', 'initiated'].includes(q.state.data?.status ?? 'pending') ? 2000 : false),
  });
  const { data: customers } = useQuery<Array<{ _id: string; name: string; phone?: string; credit?: { approved: boolean; limit: number; balance: number } }>>({ queryKey: ['credit-customers'], queryFn: () => get('/crm/customers'), enabled: method === 'account' });

  useEffect(() => {
    if (!attempt) return;
    if (attempt.status === 'succeeded') {
      get<{ order: Order }>(`/orders/${order._id}`).then((r) => {
        qc.invalidateQueries({ queryKey: ['order', order._id] });
        if (r.order.status === 'paid') {
          setPaidOrder(r.order);
          onPaid(r.order);
        } else {
          toast(`M-Pesa ${attempt.mpesaReceipt} received. Balance remaining ${money(r.order.totals.total - r.order.totals.paid)}`);
          setAttemptId(null);
        }
      });
    }
  }, [attempt?.status]);

  const quick = useMemo(() => {
    const b = Math.ceil(balance / 100);
    return [...new Set([b, Math.ceil(b / 100) * 100, Math.ceil(b / 500) * 500, Math.ceil(b / 1000) * 1000])].filter((v) => v >= b).slice(0, 4);
  }, [balance]);

  async function pay() {
    setBusy(true);
    try {
      if (method === 'mpesa') {
        const a = await post<Attempt>(`/orders/${order._id}/mpesa`, { phone, amount: Math.round(cents / 100) * 100, idempotencyKey: idemKey });
        setAttemptId(a._id);
        setIdemKey(uuid());
        return;
      }
      const body: Record<string, unknown> = { method, amount: cents, idempotencyKey: idemKey };
      if (method === 'cash') body.tendered = tenderedCents;
      if (method === 'card') body.reference = reference.trim();
      if (method === 'account') body.customerId = customerId;
      const r = await withApproval((approval) => post<{ order: Order; payment: { change: number } }>(`/orders/${order._id}/payments`, { ...body, approval }));
      setIdemKey(uuid());
      if (method === 'cash' && r.payment.change > 0) toast(`Change due: ${money(r.payment.change)}`, 'info');
      qc.invalidateQueries({ queryKey: ['order', order._id] });
      if (r.order.status === 'paid') {
        setPaidOrder(r.order);
        onPaid(r.order);
      } else toast(`Payment recorded. Balance ${money(r.order.totals.total - r.order.totals.paid)}`);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  if (paidOrder) return <ReceiptPanel order={paidOrder} onClose={onClose} />;

  const methods: Array<{ id: Method; label: string; icon: typeof Banknote; show: boolean }> = [
    { id: 'cash', label: 'Cash', icon: Banknote, show: true },
    { id: 'mpesa', label: 'M-Pesa', icon: Smartphone, show: true },
    { id: 'mpesa_manual', label: 'Manual M-Pesa', icon: CheckCircle2, show: true },
  ];
  const waiting = attempt && ['pending', 'initiated'].includes(attempt.status);

  return (
    <Modal open onClose={onClose} title={`Payment · ${order.number}`} size="lg">
      <div className="grid gap-5 md:grid-cols-[1fr_1.3fr]">
        <div className="space-y-3">
          <div className="rounded-2xl bg-brand-pale p-4">
            <p className="text-xs font-semibold uppercase text-brand-dark">Amount due</p>
            <p className="text-3xl font-bold text-brand-dark">{money(balance)}</p>
            {order.totals.paid > 0 && <p className="text-xs text-brand-dark">Paid so far {money(order.totals.paid)} of {money(order.totals.total)}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-1">
            {methods.filter((m) => m.show).map((m) => (
              <button key={m.id} onClick={() => { setMethod(m.id); setAttemptId(null); }} className={cx('flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-sm font-semibold', method === m.id ? 'border-brand bg-brand-50 text-brand-dark' : 'border-line')}>
                <m.icon className="h-5 w-5" /> {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-soft">Split payments: enter a partial amount and take the rest with another method.</p>
        </div>
        <div className="space-y-4">
          <Field label="Amount to pay (KSh)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className="h-12 text-lg font-bold" />
          </Field>
          {method === 'cash' && (
            <>
              <Field label="Cash tendered (KSh)">
                <Input inputMode="decimal" value={tendered} placeholder={amount} onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))} className="h-12 text-lg" />
              </Field>
              <div className="flex flex-wrap gap-2">{quick.map((q) => <button key={q} onClick={() => setTendered(String(q))} className="rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-page">{q.toLocaleString()}</button>)}</div>
              {tenderedCents > cents && <p className="rounded-xl bg-page px-3 py-2 text-sm">Change: <b>{money(tenderedCents - cents)}</b></p>}
            </>
          )}
          {method === 'mpesa' && (
            <>
              <Field label="Customer M-Pesa number" hint="Safaricom number, e.g. 0712 345 678. Amount is rounded to whole shillings.">
                <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-12 text-lg" />
              </Field>
              {attempt && (
                <div className={cx('rounded-xl border p-3 text-sm', attempt.status === 'succeeded' ? 'border-brand bg-brand-pale' : waiting ? 'border-warn bg-warn-pale' : 'border-danger/40 bg-danger-pale')}>
                  <div className="flex items-center gap-2 font-semibold">
                    {waiting ? <Loader2 className="h-4 w-4 animate-spin" /> : attempt.status === 'succeeded' ? <CheckCircle2 className="h-4 w-4 text-brand" /> : <XCircle className="h-4 w-4 text-danger" />}
                    {waiting ? 'Waiting for the customer to enter their M-Pesa PIN…' : attempt.status === 'succeeded' ? `Paid — ${attempt.mpesaReceipt}` : attempt.resultDesc ?? attempt.error ?? attempt.status}
                  </div>
                  {waiting && <p className="mt-1 text-xs">The order is marked paid only after Safaricom confirms the payment.</p>}
                  {attempt.provider === 'mock' && waiting && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-warn/40 pt-2">
                      <Pill color="yellow"><FlaskConical className="h-3 w-3" /> SIMULATED provider</Pill>
                      <Button size="sm" variant="secondary" onClick={() => post(`/mpesa/simulate/${attempt._id}`, { resultCode: 0 }).then(() => qc.invalidateQueries({ queryKey: ['attempt', attemptId] })).catch(handleError)}>Simulate success</Button>
                      <Button size="sm" variant="secondary" onClick={() => post(`/mpesa/simulate/${attempt._id}`, { resultCode: 1032 }).then(() => qc.invalidateQueries({ queryKey: ['attempt', attemptId] })).catch(handleError)}>Simulate cancel</Button>
                    </div>
                  )}
                  {waiting && <Button size="sm" variant="ghost" className="mt-2" onClick={() => post(`/orders/${order._id}/mpesa/${attempt._id}/cancel`).then(() => setAttemptId(null)).catch(handleError)}>Stop waiting</Button>}
                </div>
              )}
            </>
          )}
          {method === 'card' && <Field label="Terminal approval / reference code" hint="Card details are never entered here — use the bank terminal."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
          {method === 'account' && (
            <Field label="Customer credit account">
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select customer…</option>
                {customers?.filter((c) => c.credit?.approved).map((c) => <option key={c._id} value={c._id}>{c.name} — available {money((c.credit!.limit ?? 0) - (c.credit!.balance ?? 0))}</option>)}
              </Select>
            </Field>
          )}
          {method === 'mpesa_manual' && (
            <p className="rounded-xl bg-brand-pale px-3 py-2 text-sm text-brand-dark">The customer paid to your Till / Paybill number and you have seen the M-Pesa message. Completing the sale records it as M-Pesa under your name.</p>
          )}
          <Button size="lg" className="w-full" loading={busy} disabled={cents <= 0 || cents > balance || !!waiting || (method === 'cash' && tenderedCents < cents) || (method === 'card' && !reference) || (method === 'account' && !customerId)} onClick={pay}>
            {method === 'mpesa' ? (attempt && !waiting ? 'Send prompt again' : 'Send M-Pesa prompt') : method === 'mpesa_manual' ? `Complete sale · ${money(cents)}` : `Charge ${money(cents)}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReceiptPanel({ order, onClose }: { order: Order; onClose: () => void }) {
  const { toast, handleError, confirm } = useFeedback();
  const { can } = useAuth();
  const [to, setTo] = useState(order.customerPhone ? `0${order.customerPhone.slice(3)}` : '');
  const { data, refetch } = useQuery<{ text: string; doc: ReceiptDoc; printCount: number }>({ queryKey: ['receipt', order._id], queryFn: () => get(`/orders/${order._id}/receipt`) });
  async function print() {
    try {
      let reason: string | undefined;
      if ((data?.printCount ?? 0) > 0) {
        const c = await confirm({ title: 'Reprint receipt', message: 'This prints a DUPLICATE COPY and is recorded in the audit log.', reason: true, confirmLabel: 'Print duplicate' });
        if (!c.ok) return;
        reason = c.reason;
      }
      // This till's receipt printer (account menu → This till), else the branch's receipt printer, else the browser.
      const printers = await get<Array<{ _id: string; role: string; connection: string; active: boolean; name: string }>>('/integrations/printers').catch(() => []);
      const receiptPrinter = pickReceiptPrinter(printers);
      const r = await post<{ text: string; doc: ReceiptDoc; copy: 'original' | 'duplicate' }>(`/orders/${order._id}/receipt/print`, { reason, printer: receiptPrinter?.name ?? 'browser' });
      if (receiptPrinter) {
        await post(`/integrations/printers/${receiptPrinter._id}/jobs`, { kind: 'receipt', refId: order._id, copy: r.copy, payload: { text: r.text, doc: r.doc }, dedupeKey: `receipt:${order._id}:${r.copy}:${Date.now()}` });
        toast(`Sent to ${receiptPrinter.name}`);
      } else {
        try {
          printReceipt(r.doc);
        } catch (e) {
          await post(`/orders/${order._id}/receipt/print`, { status: 'failed', error: (e as Error).message, printer: 'browser' });
          throw e;
        }
      }
      refetch();
    } catch (e) {
      handleError(e);
    }
  }
  async function send(channel: 'sms' | 'email') {
    try {
      const job = await post<{ status: string; lastError?: string }>(`/orders/${order._id}/receipt/send`, { channel, to });
      toast(job.status === 'skipped' ? `Not sent: ${job.lastError}` : `Receipt queued for ${channel.toUpperCase()}`, job.status === 'skipped' ? 'error' : 'success');
    } catch (e) {
      handleError(e);
    }
  }
  return (
    <Modal open onClose={onClose} title="Payment complete" size="md" footer={<Button onClick={onClose}>New order</Button>}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-2xl bg-brand-pale p-4 text-brand-dark">
          <CheckCircle2 className="h-8 w-8" />
          <div>
            <p className="font-bold">{money(order.totals.total)} received</p>
            <p className="text-sm">Receipt {order.receiptNumber}{order.source === 'offline' ? ' · pending cloud verification' : ''}</p>
          </div>
        </div>
        <ReceiptPaper doc={data?.doc} animate />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={print} disabled={(data?.printCount ?? 0) > 0 && !can('receipts.reprint')}>
            {(data?.printCount ?? 0) > 0 ? 'Reprint (duplicate)' : 'Print receipt'}
          </Button>
        </div>
        <div className="flex gap-2">
          <Input placeholder="Phone or email" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" icon={<MessageSquare className="h-4 w-4" />} onClick={() => send('sms')} disabled={!to || to.includes('@')}>SMS</Button>
          <Button variant="secondary" icon={<Mail className="h-4 w-4" />} onClick={() => send('email')} disabled={!to.includes('@')}>Email</Button>
        </div>
      </div>
    </Modal>
  );
}

export { api };
