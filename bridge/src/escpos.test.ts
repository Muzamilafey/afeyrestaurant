import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { EscPos, render, sendToNetworkPrinter } from './escpos';

describe('ESC/POS', () => {
  it('encodes init, alignment, cut and drawer pulse', () => {
    const b = new EscPos(32).align('center').line('Hi').openDrawer().cut().build();
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(b.includes(Buffer.from([0x1b, 0x61, 1]))).toBe(true);
    expect(b.includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(true);
    expect(b.includes(Buffer.from([0x1d, 0x56, 0x42]))).toBe(true);
  });
  it('replaces characters the printer cannot print and marks duplicates', () => {
    const b = render('receipt', { text: 'Café 😀', copy: 'duplicate' }, 58).toString('ascii');
    expect(b).toContain('Cafe');
    expect(b).toContain('DUPLICATE COPY');
  });
  it('prints a structured receipt: large bold name, reverse banner, aligned rows and items', () => {
    const doc = { kind: 'receipt' as const, copy: 'duplicate' as const, lines: [
      { k: 'logo' as const, url: '/x.png' },
      { k: 'title' as const, t: 'AFEY RESORT' },
      { k: 'banner' as const, t: 'DUPLICATE COPY' },
      { k: 'rule' as const, heavy: true },
      { k: 'item' as const, qty: 2, name: 'Classic Beef Burger', total: '2,200.00', each: '1,100.00', mods: ['Medium'] },
      { k: 'row' as const, l: 'TOTAL', r: 'KSh 2,200.00', bold: true, big: true },
    ] };
    const b = render('receipt', { doc }, 58);
    const s = b.toString('ascii');
    expect(b.includes(Buffer.from([0x1d, 0x21, 0x11]))).toBe(true); // double size title
    expect(b.includes(Buffer.from([0x1d, 0x42, 1]))).toBe(true); // reverse banner
    expect(b.includes(Buffer.from([0x1d, 0x21, 0x01]))).toBe(true); // tall total
    expect(s).toContain('AFEY RESORT');
    expect(s).toMatch(/2 x Classic Beef Burger +2,200\.00\n/);
    expect(s).toContain('    + Medium');
    expect(s).toMatch(/TOTAL {2,}KSh 2,200\.00/);
    expect(s.split('\n').every((l) => l.replace(/[\x00-\x1f]./g, '').length <= 34)).toBe(true);
  });
  it('sends bytes to a network printer and reports unreachable printers', async () => {
    const received: Buffer[] = [];
    const srv = net.createServer((s) => s.on('data', (d) => received.push(d)));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await sendToNetworkPrinter('127.0.0.1', port, Buffer.from('hello'));
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(received).toString()).toBe('hello');
    srv.close();
    await expect(sendToNetworkPrinter('127.0.0.1', 1, Buffer.from('x'), 500)).rejects.toThrow(/unreachable|timed out/);
  });
});
