import { useMemo, useState } from 'react';
import { Banknote, CloudOff, CreditCard, Printer, Smartphone } from 'lucide-react';
import { Button, Field, Input, Modal, cx } from '@/components/ui';
import { money, toCents } from '@/lib/format';

export type OfflineMethod = 'cash' | 'card' | 'mpesa';
export interface OfflinePayment {
  method: OfflineMethod;
  tendered?: number;
  reference?: string;
  phone?: string;
  printTickets: boolean;
}

const MPESA_CODE = /^[A-Z0-9]{8,12}$/;

/**
 * Taking payment while the server cannot be reached. The sale is stored on this till and uploaded when the
 * connection returns. Cash and card work as usual; for M-Pesa the customer pays to the Till/Paybill number and the
 * cashier types the code from the customer's SMS, which is confirmed against Safaricom once back online.
 */
export function OfflinePayDialog({ total, allowed, hasTickets, onClose, onConfirm }: { total: number; allowed: Record<OfflineMethod, boolean>; hasTickets: boolean; onClose: () => void; onConfirm: (p: OfflinePayment) => void }) {
  const first = (['cash', 'mpesa', 'card'] as const).find((m) => allowed[m]) ?? 'cash';
  const [method, setMethod] = useState<OfflineMethod>(first);
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState('');
  const [printTickets, setPrintTickets] = useState(hasTickets);

  const given = tendered ? toCents(tendered) : total;
  const quick = useMemo(() => {
    const k = total / 100;
    return [...new Set([k, Math.ceil(k / 100) * 100, Math.ceil(k / 500) * 500, Math.ceil(k / 1000) * 1000])].filter((v) => v >= k).slice(0, 4);
  }, [total]);
  const code = reference.trim().toUpperCase();
  const ok = method === 'cash' ? given >= total : method === 'mpesa' ? MPESA_CODE.test(code) : true;
  const label = method === 'cash' ? 'Record cash sale' : method === 'card' ? 'Record card sale' : 'Record M-Pesa sale';

  const methods: Array<{ id: OfflineMethod; name: string; icon: typeof Banknote }> = [
    { id: 'cash', name: 'Cash', icon: Banknote },
    { id: 'mpesa', name: 'M-Pesa (code)', icon: Smartphone },
    { id: 'card', name: 'Card', icon: CreditCard },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title="Offline sale"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!ok} onClick={() => onConfirm({ method, tendered: method === 'cash' ? given : undefined, reference: method === 'cash' ? undefined : method === 'mpesa' ? code : reference.trim() || undefined, phone: method === 'mpesa' ? phone.trim() || undefined : undefined, printTickets })}>
            {label} · {money(total)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-3 rounded-2xl bg-warn-pale p-3 text-sm text-warn-ink">
          <CloudOff className="h-5 w-5 shrink-0" />
          <p>No connection to the server. This sale is saved on this till and uploaded automatically when the connection returns — keep selling as normal.</p>
        </div>
        <div className="rounded-2xl bg-brand-pale p-4">
          <p className="text-xs font-semibold uppercase text-brand-dark">Amount due</p>
          <p className="text-3xl font-bold tabular-nums text-brand-dark">{money(total)}</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {methods.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={!allowed[m.id]}
              onClick={() => setMethod(m.id)}
              title={allowed[m.id] ? undefined : 'Switched off for offline sales in Settings → Business'}
              aria-pressed={method === m.id}
              className={cx('flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40', method === m.id ? 'border-brand bg-brand text-white shadow-soft' : 'border-line bg-card text-ink hover:border-brand/50')}
            >
              <m.icon className="h-5 w-5" /> {m.name}
            </button>
          ))}
        </div>

        {method === 'cash' && (
          <div className="space-y-2">
            <Field label="Cash given (KSh)"><Input inputMode="decimal" autoFocus value={tendered} placeholder={(total / 100).toFixed(2)} onChange={(e) => setTendered(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              {quick.map((v) => <Button key={v} size="sm" variant="secondary" onClick={() => setTendered(String(v))}>{v.toLocaleString('en-KE')}</Button>)}
            </div>
            <p className={cx('text-sm font-semibold', given < total ? 'text-danger' : 'text-ink')}>{given < total ? `Short by ${money(total - given)}` : `Change: ${money(given - total)}`}</p>
          </div>
        )}
        {method === 'mpesa' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">Ask the customer to pay <b>{money(total)}</b> to your <b>Till / Paybill</b> number, then type the code from their M-Pesa SMS. It is confirmed with Safaricom automatically once the connection is back.</p>
            <Field label="M-Pesa code" error={reference && !MPESA_CODE.test(code) ? 'Codes are 10 letters and numbers, e.g. SJK8H2LQ1P' : undefined}>
              <Input autoFocus value={reference} onChange={(e) => setReference(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="SJK8H2LQ1P" maxLength={12} className="font-mono uppercase tracking-wider" />
            </Field>
            <Field label="Customer phone (optional)"><Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" /></Field>
          </div>
        )}
        {method === 'card' && (
          <Field label="Approval code from the card machine (optional)"><Input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} /></Field>
        )}

        {hasTickets && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={printTickets} onChange={(e) => setPrintTickets(e.target.checked)} />
            <Printer className="h-4 w-4 text-ink-soft" /> Print kitchen / bar tickets (the kitchen screen can't receive it while offline)
          </label>
        )}
      </div>
    </Modal>
  );
}
