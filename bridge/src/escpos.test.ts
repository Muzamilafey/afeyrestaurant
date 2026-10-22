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
