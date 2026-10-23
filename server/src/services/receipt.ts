/**
 * Receipt layout. The server builds one structured receipt; each output renders it natively:
 *   - the web app prints it as a styled 80mm page and shows it as a preview,
 *   - the local bridge prints it on ESC/POS thermal printers (bold / double size / centred),
 *   - docToText() gives the fixed-width text used for SMS, email and older clients.
 * Only printable ASCII is used in the fixed parts, so thermal code pages print it cleanly.
 */

export type ReceiptLine =
  | { k: 'logo'; url: string }
  | { k: 'title'; t: string }
  | { k: 'center'; t: string; bold?: boolean; muted?: boolean }
  | { k: 'banner'; t: string }
  | { k: 'rule'; heavy?: boolean }
  | { k: 'row'; l: string; r: string; bold?: boolean; big?: boolean; muted?: boolean }
  | { k: 'item'; qty: number; name: string; total: string; each?: string; mods: string[] }
  | { k: 'space' };

export interface ReceiptDoc {
  kind: 'receipt' | 'bill';
  copy: 'original' | 'duplicate';
  lines: ReceiptLine[];
}

export interface ReceiptData {
  business: { name?: string | null; kraPin?: string | null; header?: string | null; footer?: string | null; logoUrl?: string | null; timezone?: string | null };
  branch: { name?: string | null; address?: string | null; phone?: string | null };
  order: { number?: string | null; receiptNumber?: string | null; type?: string | null; table?: string | null; waiter?: string | null; cashier?: string | null; customer?: string | null; guests?: number | null; createdAt?: Date | null; paidAt?: Date | null; status?: string | null; offline?: boolean };
  lines: Array<{ name: string; qty: number; unitPrice: number; total: number; modifiers: string[]; complimentary: boolean }>;
  totals?: { subtotal?: number | null; discount?: number | null; serviceCharge?: number | null; deliveryFee?: number | null; total?: number | null; paid?: number | null; balance?: number | null } | null;
  taxes?: Array<{ code?: string | null; name?: string | null; rateBps?: number | null; inclusive?: boolean | null; amount?: number | null }> | null;
  payments: Array<{ method: string; amount: number; tendered?: number | null; change?: number | null; reference?: string | null; phone?: string | null; pending?: boolean }>;
}

/** 123456 cents → "1,234.56" */
export const amount = (cents: number | null | undefined) => ((cents ?? 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const METHOD: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', qr: 'QR', account: 'On account', voucher: 'Voucher' };
const TYPE: Record<string, string> = { dine_in: 'Dine in', takeaway: 'Takeaway', delivery: 'Delivery', bar_counter: 'Bar', room_service: 'Room service', online: 'Online' };
/** 0712345678 → 0712***678 */
const maskPhone = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 4)}***${p.slice(-3)}` : p ?? '');

export function receiptDoc(r: ReceiptData, copy: 'original' | 'duplicate' = 'original'): ReceiptDoc {
  const isReceipt = r.order.status === 'paid';
  const tz = r.business.timezone ?? 'Africa/Nairobi';
  const when = r.order.paidAt ?? r.order.createdAt ?? new Date();
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(when);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when);
  const t = r.totals ?? {};
  const L: ReceiptLine[] = [];

  // ── Header
  if (r.business.logoUrl) L.push({ k: 'logo', url: r.business.logoUrl });
  L.push({ k: 'title', t: (r.business.name ?? 'Chili POS').toUpperCase() });
  if (r.branch.name) L.push({ k: 'center', t: r.branch.name, bold: true });
  if (r.branch.address) L.push({ k: 'center', t: r.branch.address, muted: true });
  if (r.branch.phone) L.push({ k: 'center', t: `Tel: ${r.branch.phone}`, muted: true });
  if (r.business.kraPin) L.push({ k: 'center', t: `KRA PIN: ${r.business.kraPin}`, muted: true });
  if (r.business.header) L.push({ k: 'space' }, { k: 'center', t: r.business.header });
  L.push({ k: 'rule', heavy: true });

  if (copy === 'duplicate') L.push({ k: 'banner', t: 'DUPLICATE COPY' });
  if (r.order.offline) L.push({ k: 'banner', t: 'OFFLINE SALE - PENDING SYNC' });
  L.push({ k: 'center', t: isReceipt ? 'SALES RECEIPT' : 'BILL - NOT A RECEIPT', bold: true });
  L.push({ k: 'space' });

  // ── Order details
  if (isReceipt && r.order.receiptNumber) L.push({ k: 'row', l: 'Receipt No.', r: r.order.receiptNumber });
  L.push({ k: 'row', l: 'Order', r: r.order.number ?? '' });
  L.push({ k: 'row', l: 'Date', r: `${date}  ${time}` });
  const service = [TYPE[r.order.type ?? ''] ?? '', r.order.table ? `Table ${r.order.table}` : ''].filter(Boolean).join(' - ');
  if (service) L.push({ k: 'row', l: 'Service', r: service });
  if (r.order.guests && r.order.type === 'dine_in') L.push({ k: 'row', l: 'Guests', r: String(r.order.guests) });
  if (r.order.waiter) L.push({ k: 'row', l: 'Served by', r: r.order.waiter });
  if (r.order.cashier && r.order.cashier !== r.order.waiter) L.push({ k: 'row', l: 'Cashier', r: r.order.cashier });
  if (r.order.customer) L.push({ k: 'row', l: 'Customer', r: r.order.customer });
  L.push({ k: 'rule' });

  // ── Items
  for (const it of r.lines) {
    L.push({ k: 'item', qty: it.qty, name: it.name, total: it.complimentary ? 'FREE' : amount(it.total), each: it.qty > 1 && !it.complimentary ? amount(it.unitPrice) : undefined, mods: it.modifiers });
  }
  L.push({ k: 'rule' });

  // ── Totals
  const itemCount = r.lines.reduce((a, l) => a + l.qty, 0);
  L.push({ k: 'row', l: `Subtotal (${itemCount} item${itemCount === 1 ? '' : 's'})`, r: amount(t.subtotal) });
  if (t.discount) L.push({ k: 'row', l: 'Discount', r: `-${amount(t.discount)}` });
  if (t.serviceCharge) L.push({ k: 'row', l: 'Service charge', r: amount(t.serviceCharge) });
  if (t.deliveryFee) L.push({ k: 'row', l: 'Delivery fee', r: amount(t.deliveryFee) });
  for (const x of r.taxes ?? []) if (!x.inclusive && x.amount) L.push({ k: 'row', l: `${x.code ?? x.name ?? 'Tax'} ${((x.rateBps ?? 0) / 100).toFixed(0)}%`, r: amount(x.amount) });
  L.push({ k: 'rule', heavy: true });
  L.push({ k: 'row', l: isReceipt ? 'TOTAL' : 'AMOUNT DUE', r: `KSh ${amount(isReceipt ? t.total : (t.total ?? 0) - (t.paid ?? 0))}`, bold: true, big: true });
  L.push({ k: 'rule', heavy: true });

  // ── Payments
  if (r.payments.length) {
    for (const p of r.payments) {
      const ref = p.method === 'mpesa' ? [p.reference, maskPhone(p.phone)].filter(Boolean).join(' ') : p.reference && p.method !== 'cash' ? p.reference : '';
      L.push({ k: 'row', l: `${METHOD[p.method] ?? p.method}${ref ? ` ${ref}` : ''}`, r: amount(p.amount), bold: true });
      if (p.pending) L.push({ k: 'row', l: '  (being confirmed with M-Pesa)', r: '', muted: true });
      if (p.method === 'cash' && p.tendered && p.tendered > p.amount) {
        L.push({ k: 'row', l: '  Cash given', r: amount(p.tendered), muted: true });
        L.push({ k: 'row', l: '  Change', r: amount(p.change ?? p.tendered - p.amount), muted: true });
      }
    }
    if (!isReceipt && (t.paid ?? 0) > 0) L.push({ k: 'row', l: 'Balance due', r: amount((t.total ?? 0) - (t.paid ?? 0)), bold: true });
  }

  // ── Tax summary (prices include VAT)
  const incl = (r.taxes ?? []).filter((x) => x.inclusive && x.amount);
  if (incl.length) {
    L.push({ k: 'space' });
    for (const x of incl) L.push({ k: 'row', l: `${x.code ?? x.name ?? 'Tax'} ${((x.rateBps ?? 0) / 100).toFixed(0)}% included`, r: amount(x.amount), muted: true });
  }

  // ── Footer
  L.push({ k: 'rule' });
  L.push({ k: 'center', t: r.business.footer || 'Thank you for dining with us!', bold: true });
  if (!isReceipt) L.push({ k: 'center', t: 'Please ask for your receipt after payment.', muted: true });
  L.push({ k: 'center', t: 'Powered by Chili POS', muted: true });
  return { kind: isReceipt ? 'receipt' : 'bill', copy, lines: L };
}

const center = (s: string, cols: number) => (s.length >= cols ? s : ' '.repeat(Math.floor((cols - s.length) / 2)) + s);
/** Word-wrap to a width. */
function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
    while (cur.length > width) {
      out.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
function pair(l: string, r: string, cols: number): string[] {
  if (l.length + r.length + 1 <= cols) return [l + ' '.repeat(cols - l.length - r.length) + r];
  return [...wrap(l, cols), ' '.repeat(Math.max(0, cols - r.length)) + r];
}

/** Fixed-width text rendering (SMS, email, plain printers). */
export function docToText(doc: ReceiptDoc, cols = 40): string {
  const out: string[] = [];
  for (const ln of doc.lines) {
    switch (ln.k) {
      case 'logo':
        break;
      case 'title':
        for (const w of wrap(ln.t, cols)) out.push(center(w, cols));
        break;
      case 'center':
        for (const w of wrap(ln.t, cols)) out.push(center(w, cols));
        break;
      case 'banner':
        out.push(center(`*** ${ln.t} ***`, cols));
        break;
      case 'rule':
        out.push((ln.heavy ? '=' : '-').repeat(cols));
        break;
      case 'row':
        out.push(...pair(ln.l, ln.r, cols));
        break;
      case 'item': {
        const [first, ...rest] = wrap(`${ln.qty} x ${ln.name}`, cols - ln.total.length - 1);
        out.push(...pair(first, ln.total, cols), ...rest.map((x) => `    ${x}`));
        if (ln.each) out.push(`    @ ${ln.each}`);
        for (const m of ln.mods) out.push(`    + ${m}`);
        break;
      }
      case 'space':
        out.push('');
        break;
    }
  }
  return out.join('\n');
}
