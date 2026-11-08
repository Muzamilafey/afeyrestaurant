/**
 * Receipt printing in the browser. The server sends a structured receipt (see server/src/services/receipt.ts); it is
 * rendered here as a styled 80mm page. The local bridge prints the same receipt on ESC/POS printers when configured.
 */

import QRCode from 'qrcode';

export type ReceiptLine =
  | { k: 'logo'; url: string }
  | { k: 'title'; t: string }
  | { k: 'center'; t: string; bold?: boolean; muted?: boolean }
  | { k: 'banner'; t: string }
  | { k: 'rule'; heavy?: boolean }
  | { k: 'row'; l: string; r: string; bold?: boolean; big?: boolean; muted?: boolean }
  | { k: 'item'; qty: number; name: string; total: string; each?: string; mods: string[] }
  | { k: 'space' }
  | { k: 'qr'; data: string };
export interface ReceiptDoc {
  kind: 'receipt' | 'bill' | 'report';
  copy: 'original' | 'duplicate';
  lines: ReceiptLine[];
}

/** QR code as inline SVG (synchronous, so receipts render in one pass). */
function qrSvg(data: string) {
  try {
    const q = QRCode.create(data, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    let path = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(x, y)) path += `M${x + 2} ${y + 2}h1v1h-1z`;
    return `<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  } catch {
    return '';
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const cls = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** Styles scoped to .rcpt — used by the print window and the on-screen preview, so both look the same. */
export const RECEIPT_CSS = `
.rcpt{font:12px/1.45 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111;background:#fff}
.rcpt .logo{display:block;margin:0 auto 6px;max-height:56px;max-width:55%;object-fit:contain;filter:grayscale(1) contrast(1.2)}
.rcpt .title{text-align:center;font-weight:800;font-size:17px;letter-spacing:.06em;line-height:1.2;margin-bottom:2px}
.rcpt .c{text-align:center}
.rcpt .b{font-weight:700}
.rcpt .m{color:#555;font-size:11px}
.rcpt .rule{border-top:1px dashed #111;margin:7px 0}
.rcpt .rule.h{border-top:2px solid #111}
.rcpt .banner{text-align:center;background:#111;color:#fff;font-weight:800;letter-spacing:.12em;font-size:11px;padding:3px 0;margin:4px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rcpt .row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.rcpt .row>span:last-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rcpt .row.big{font-size:16px;font-weight:800;margin:2px 0}
.rcpt .item{margin:3px 0}
.rcpt .item .qty{display:inline-block;min-width:22px;font-weight:700}
.rcpt .item .sub{padding-left:22px;color:#555;font-size:11px}
.rcpt .sp{height:6px}
.rcpt .qr{display:block;width:34mm;height:34mm;margin:6px auto}
`;

/** Receipt body as HTML (escaped). */
export function receiptHtml(doc: ReceiptDoc) {
  return doc.lines
    .map((l) => {
      switch (l.k) {
        case 'logo':
          return `<img class="logo" src="${esc(l.url)}" alt="" onerror="this.remove()">`;
        case 'title':
          return `<div class="title">${esc(l.t)}</div>`;
        case 'center':
          return `<div class="${cls('c', l.bold && 'b', l.muted && 'm')}">${esc(l.t)}</div>`;
        case 'banner':
          return `<div class="banner">${esc(l.t)}</div>`;
        case 'rule':
          return `<div class="${cls('rule', l.heavy && 'h')}"></div>`;
        case 'row':
          return `<div class="${cls('row', l.bold && 'b', l.big && 'big', l.muted && 'm')}"><span>${esc(l.l)}</span><span>${esc(l.r)}</span></div>`;
        case 'item':
          return `<div class="item"><div class="row"><span><span class="qty">${l.qty}×</span>${esc(l.name)}</span><span>${esc(l.total)}</span></div>${l.each ? `<div class="sub">@ ${esc(l.each)} each</div>` : ''}${l.mods.map((m) => `<div class="sub">+ ${esc(m)}</div>`).join('')}</div>`;
        case 'space':
          return '<div class="sp"></div>';
        case 'qr':
          return qrSvg(l.data);
        default:
          return '';
      }
    })
    .join('');
}

function openPrintWindow(body: string, title: string, css: string) {
  const w = window.open('', '_blank', 'width=400,height=640');
  if (!w) throw new Error('Pop-up blocked — allow pop-ups to print');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:80mm auto;margin:3mm}html,body{margin:0;background:#fff}${css}</style></head><body>${body}<script>
    const go=()=>{window.print();setTimeout(()=>window.close(),300)};
    const imgs=[...document.images];Promise.all(imgs.map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r}))).then(()=>setTimeout(go,50));
  </script></body></html>`);
  w.document.close();
}

/** Print a structured receipt or bill in the browser (80mm thermal paper or A4 — it centres itself). */
export function printReceipt(doc: ReceiptDoc | ReceiptDoc[], title?: string) {
  // Several slips (e.g. receipt + kitchen ticket) go out as one print job, each on its own page / cut.
  const docs = Array.isArray(doc) ? doc : [doc];
  const body = docs.map((d, i) => `<div class="rcpt" style="width:72mm;margin:0 auto;padding:2mm 0;${i < docs.length - 1 ? 'break-after:page;page-break-after:always' : ''}">${receiptHtml(d)}</div>`).join('');
  openPrintWindow(body, title ?? (docs[0].kind === 'bill' ? 'Bill' : 'Receipt'), RECEIPT_CSS);
}

/** Browser fallback printing for plain text (kept for anything not yet structured). */
export function printText(text: string, title = 'Receipt') {
  const body = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  openPrintWindow(body, title, "body{font:12px/1.35 'Courier New',monospace;white-space:pre-wrap}");
}
