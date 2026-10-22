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

export interface PrintPayload {
  title?: string;
  text?: string;
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
  } else {
    e.align('left');
    if (p.copy === 'duplicate') e.align('center').bold(true).line('*** DUPLICATE COPY ***').bold(false).align('left');
    for (const l of (p.text ?? '').split('\n')) e.line(l);
  }
  if (p.openDrawer) e.openDrawer();
  return e.cut().build();
}
