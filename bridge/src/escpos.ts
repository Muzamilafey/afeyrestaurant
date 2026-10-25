import net from 'node:net';

/** Minimal ESC/POS encoder for 58/80mm thermal printers. */
const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private chunks: Buffer[] = [Buffer.from([ESC, 0x40])]; // initialise
  constructor(public width = 48) {}
  private raw(...b: number[]) {
    this.chunks.push(Buffer.from(b));
    return this;
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  size(double: boolean) {
    return this.raw(GS, 0x21, double ? 0x11 : 0x00);
  }
  /** Double height only — keeps the full line width (used for the total). */
  tall(on: boolean) {
    return this.raw(GS, 0x21, on ? 0x01 : 0x00);
  }
  /** White on black (reverse) printing for banners. */
  invert(on: boolean) {
    return this.raw(GS, 0x42, on ? 1 : 0);
  }
  text(s: string) {
    // Printers use a single-byte code page; replace characters they cannot print.
    this.chunks.push(Buffer.from(s.normalize('NFKD').replace(/[^\x20-\x7E\n]/g, '?'), 'ascii'));
    return this;
  }
  line(s = '') {
    return this.text(`${s}\n`);
  }
  rule(ch = '-') {
    return this.line(ch.repeat(this.width));
  }
  /** Left and right text on one line. */
  pair(left: string, right: string) {
    const space = Math.max(1, this.width - left.length - right.length);
    return this.line(left.slice(0, this.width - right.length - 1) + ' '.repeat(space) + right);
  }
  feed(n = 3) {
    return this.raw(ESC, 0x64, n);
  }
  cut() {
    return this.feed(3).raw(GS, 0x56, 0x42, 0x00);
  }
  /** QR code printed by the printer itself (GS ( k, model 2), centred. */
  qr(data: string, moduleSize = 6) {
    const bytes = Buffer.from(data, 'ascii');
    const len = bytes.length + 3;
    this.align('center');
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // model 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, moduleSize); // module size
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
    this.raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30);
    this.chunks.push(bytes);
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
    return this.line().align('left');
  }
  /** Pulse the cash drawer connected to the printer's DK port. */
  openDrawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }
  build() {
    return Buffer.concat(this.chunks);
  }
}

/** Send raw bytes to a network printer (port 9100). Resolves only after the data has been written. */
export function sendToNetworkPrinter(host: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error(`Printer ${host}:${port} timed out`)));
    sock.on('error', (e) => fail(new Error(`Printer ${host}:${port} unreachable: ${e.message}`)));
    sock.on('connect', () => sock.end(data, () => resolve()));
  });
}

/** Structured receipt from the server (server/src/services/receipt.ts). */
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

export interface PrintPayload {
  title?: string;
  text?: string;
  doc?: { kind: 'receipt' | 'bill'; copy: 'original' | 'duplicate'; lines: ReceiptLine[] };
  lines?: Array<{ qty?: number; name: string; notes?: string; modifiers?: string[] }>;
  meta?: string[];
  copy?: 'original' | 'duplicate';
  openDrawer?: boolean;
}

/** Render a job payload: free text (receipts/bills produced by the server) or a kitchen/bar ticket. */
export function render(kind: string, p: PrintPayload, paperWidth: 58 | 80): Buffer {
  const e = new EscPos(paperWidth === 58 ? 32 : 48);
  if (kind === 'cash_drawer') return e.openDrawer().build();
  if (p.title) e.align('center').bold(true).size(true).line(p.title).size(false).bold(false);
  if (kind === 'kitchen_ticket' || kind === 'bar_ticket') {
    e.align('left');
    for (const m of p.meta ?? []) e.line(m);
    e.rule();
    for (const l of p.lines ?? []) {
      e.bold(true).size(true).line(`${l.qty ?? 1} x ${l.name}`).size(false).bold(false);
      for (const m of l.modifiers ?? []) e.line(`   + ${m}`);
      if (l.notes) e.line(`   ! ${l.notes}`);
    }
    e.rule();
  } else if (p.doc) {
    renderDoc(e, p.doc.lines);
  } else {
    e.align('left');
    if (p.copy === 'duplicate') e.align('center').bold(true).line('*** DUPLICATE COPY ***').bold(false).align('left');
    for (const l of (p.text ?? '').split('\n')) e.line(l);
  }
  if (p.openDrawer) e.openDrawer();
  return e.cut().build();
}

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

/** Lay out a structured receipt for the printer: big bold name and total, reverse banners, aligned columns. */
function renderDoc(e: EscPos, lines: ReceiptLine[]) {
  const W = e.width;
  for (const l of lines) {
    switch (l.k) {
      case 'logo': // raster logos need per-printer setup; the business name is printed large instead
        break;
      case 'title':
        e.align('center').bold(true).size(true);
        for (const w of wrap(l.t, Math.floor(W / 2))) e.line(w);
        e.size(false).bold(false).align('left');
        break;
      case 'center':
        e.align('center').bold(!!l.bold);
        for (const w of wrap(l.t, W)) e.line(w);
        e.bold(false).align('left');
        break;
      case 'banner':
        e.align('center').bold(true).invert(true).line(` ${l.t} `).invert(false).bold(false).align('left');
        break;
      case 'rule':
        e.rule(l.heavy ? '=' : '-');
        break;
      case 'row':
        e.bold(!!l.bold || !!l.big);
        if (l.big) e.tall(true);
        if (l.l.length + l.r.length + 1 <= W) e.pair(l.l, l.r);
        else {
          for (const w of wrap(l.l, W)) e.line(w);
          e.align('right').line(l.r).align('left');
        }
        if (l.big) e.tall(false);
        e.bold(false);
        break;
      case 'item': {
        const [first, ...rest] = wrap(`${l.qty} x ${l.name}`, W - l.total.length - 1);
        e.bold(true).pair(first, l.total).bold(false);
        for (const r of rest) e.line(`    ${r}`);
        if (l.each) e.line(`    @ ${l.each}`);
        for (const m of l.mods) e.line(`    + ${m}`);
        break;
      }
      case 'space':
        e.line();
        break;
      case 'qr':
        e.qr(l.data);
        break;
    }
  }
}
