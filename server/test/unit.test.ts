import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { computeTotals, inWindow, resolvePrice } from '../src/services/pricing';
import { normalizeKePhone } from '../src/lib/phone';
import { parseStkCallback, stkPassword, darajaTimestamp } from '../src/integrations/mpesa/daraja';
import { renderTemplate, smsSegments } from '../src/lib/template';
import { encryptSecret, decryptSecret, maskSecret } from '../src/lib/crypto';
import { toBaseQty } from '../src/lib/units';
import { toCsv } from '../src/services/attendance';
import { receiptDoc, docToText } from '../src/services/receipt';

describe('pricing', () => {
  const vat = { _id: new Types.ObjectId(), code: 'VAT', rateBps: 1600, inclusive: true };
  const levy = { _id: new Types.ObjectId(), code: 'LVY', rateBps: 200, inclusive: false };
  it('extracts inclusive VAT and adds exclusive taxes and service charge', () => {
    const t = computeTotals({
      items: [{ qty: 2, unitPrice: 58000, taxRateIds: [vat._id] }, { qty: 1, unitPrice: 10000, taxRateIds: [vat._id, levy._id], serviceChargeApplies: false }],
      orderDiscount: { type: 'none', value: 0 }, serviceChargeBps: 500, serviceChargeEligible: true, deliveryFee: 0, taxes: [vat, levy],
    });
    expect(t.subtotal).toBe(126000);
    expect(t.taxInclusive).toBe(16000 + 1379); // 116000 → 16000 VAT; 10000 → 1379 VAT
    expect(t.taxExclusive).toBe(200);
    expect(t.serviceCharge).toBe(5800); // 5% of 116000 only
    expect(t.total).toBe(126000 + 5800 + 200);
  });
  it('allocates order discounts across lines and ignores voided/complimentary lines', () => {
    const t = computeTotals({
      items: [{ qty: 1, unitPrice: 10000 }, { qty: 1, unitPrice: 30000 }, { qty: 1, unitPrice: 99999, voided: true }, { qty: 1, unitPrice: 5000, complimentary: true }],
      orderDiscount: { type: 'percent', value: 10 }, serviceChargeBps: 0, serviceChargeEligible: false, deliveryFee: 15000, taxes: [],
    });
    expect(t.subtotal).toBe(40000);
    expect(t.discount).toBe(4000);
    expect(t.total).toBe(36000 + 15000);
  });
  it('handles overnight windows and happy hour pricing', () => {
    expect(inWindow('23:30', '22:00', '02:00')).toBe(true);
    expect(inWindow('03:00', '22:00', '02:00')).toBe(false);
    const p = { _id: new Types.ObjectId(), price: 35000, happyHourPrice: 28000, categoryId: new Types.ObjectId() };
    const hh = [{ days: [1], start: '17:00', end: '19:00' }];
    expect(resolvePrice(p, { branchId: new Types.ObjectId(), happyHours: hh, now: { day: 1, time: '17:30' } })).toMatchObject({ price: 28000, happyHour: true });
    expect(resolvePrice(p, { branchId: new Types.ObjectId(), happyHours: hh, now: { day: 2, time: '17:30' } })).toMatchObject({ price: 35000, happyHour: false });
  });
});

describe('helpers', () => {
  it('normalises Kenyan phone numbers', () => {
    expect(normalizeKePhone('0712 345 678')).toBe('254712345678');
    expect(normalizeKePhone('+254110000000')).toBe('254110000000');
    expect(normalizeKePhone('712345678')).toBe('254712345678');
    expect(normalizeKePhone('0812345678')).toBeNull();
    expect(normalizeKePhone('abc')).toBeNull();
  });
  it('builds Daraja passwords/timestamps and parses STK callbacks', () => {
    expect(stkPassword('174379', 'pk', '20240101120000')).toBe(Buffer.from('174379pk20240101120000').toString('base64'));
    expect(darajaTimestamp(new Date('2024-01-01T09:00:00Z'))).toBe('20240101120000'); // EAT = UTC+3
    const ok = parseStkCallback({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }, { Name: 'MpesaReceiptNumber', Value: 'QWE123RTY4' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } });
    expect(ok).toMatchObject({ resultCode: 0, amount: 100, mpesaReceipt: 'QWE123RTY4', phone: '254712345678' });
    expect(parseStkCallback({ foo: 1 })).toBeNull();
  });
  it('renders templates and counts SMS segments', () => {
    expect(renderTemplate('Hi {{name}}, {{missing}}!', { name: 'Ann' })).toEqual({ text: 'Hi Ann, !', missing: ['missing'] });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('Karibu 😀').encoding).toBe('UCS-2');
  });
  it('encrypts secrets with AES-GCM and masks them', () => {
    const c = encryptSecret('super-secret');
    expect(c).not.toContain('super-secret');
    expect(decryptSecret(c)).toBe('super-secret');
    expect(() => decryptSecret(c.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')))).toThrow();
    expect(maskSecret('abcdef123')).toBe('••••f123');
  });
  it('converts units including bottle and shot', () => {
    const gin = { baseUnit: 'ml', units: [{ name: 'bottle', factor: 750 }, { name: 'shot', factor: 25 }] };
    expect(toBaseQty(2, 'bottle', gin)).toBe(1500);
    expect(toBaseQty(1, 'shot', gin)).toBe(25);
    expect(toBaseQty(1.5, 'l', gin)).toBe(1500);
    expect(() => toBaseQty(1, 'kg', gin)).toThrow();
  });
  it('neutralises CSV formula injection', () => {
    expect(toCsv([{ a: '=HYPERLINK("x")', b: 'ok' }])).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('receipt layout', () => {
  const data = {
    business: { name: 'Afey Resort', kraPin: 'P051234567X', footer: 'Asante sana!', timezone: 'Africa/Nairobi' },
    branch: { name: 'Main', phone: '0712 345 678' },
    order: { number: 'ORD-1', receiptNumber: 'RC-1', type: 'dine_in', table: 'M1', waiter: 'Grace', guests: 2, paidAt: new Date('2026-10-22T16:21:00Z'), status: 'paid' },
    lines: [{ name: 'Classic Beef Burger with a very long descriptive name', qty: 2, unitPrice: 110000, total: 220000, modifiers: ['Medium'], complimentary: false }, { name: 'Water', qty: 1, unitPrice: 5000, total: 5000, modifiers: [], complimentary: true }],
    totals: { subtotal: 225000, discount: 0, serviceCharge: 0, total: 220000, paid: 220000, balance: 0 },
    taxes: [{ code: 'VAT', rateBps: 1600, inclusive: true, amount: 30345 }],
    payments: [{ method: 'mpesa', amount: 100000, reference: 'SJK8H2LQ1P', phone: '0712345678' }, { method: 'cash', amount: 120000, tendered: 150000, change: 30000 }],
  };
  it('lays out a receipt that fits the paper width, with local time and masked phone numbers', () => {
    for (const cols of [32, 40, 48]) {
      const text = docToText(receiptDoc(data), cols);
      expect(text.split('\n').every((l) => l.length <= cols)).toBe(true);
    }
    const text = docToText(receiptDoc(data));
    expect(text).toContain('AFEY RESORT');
    expect(text).toContain('22 Oct 2026  19:21'); // Nairobi time
    expect(text).toMatch(/TOTAL +KSh 2,200\.00/);
    expect(text).toContain('0712***678');
    expect(text).not.toContain('0712345678');
    expect(text).toMatch(/Change +300\.00/);
    expect(text).toMatch(/1 x Water +FREE/);
    expect(text).toMatch(/VAT 16% included +303\.45/);
  });
  it('marks bills and duplicates', () => {
    const bill = docToText(receiptDoc({ ...data, order: { ...data.order, status: 'open', receiptNumber: null }, payments: [], totals: { ...data.totals, paid: 0 } }));
    expect(bill).toContain('BILL - NOT A RECEIPT');
    expect(bill).toMatch(/AMOUNT DUE +KSh 2,200\.00/);
    expect(bill).not.toContain('Receipt No.');
    expect(docToText(receiptDoc(data, 'duplicate'))).toContain('*** DUPLICATE COPY ***');
  });
});

describe('Daraja callback URLs', () => {
  it('rejects addresses Safaricom refuses or cannot reach, with a reason', async () => {
    const { checkCallbackBase } = await import('../src/modules/mpesa/routes');
    expect(() => checkCallbackBase('https://172.17.88.153')).toThrow(/private\/local address/);
    expect(() => checkCallbackBase('https://localhost')).toThrow(/private\/local address/);
    expect(() => checkCallbackBase('http://pos.example.co.ke')).toThrow(/https/);
    expect(() => checkCallbackBase('https://mpesa.example.co.ke')).toThrow(/containing "mpesa"/);
    expect(() => checkCallbackBase('https://pos.example.co.ke/M-Pesa')).toThrow(/containing "M-Pesa"/);
    expect(() => checkCallbackBase('https://pos.example.co.ke')).not.toThrow();
    expect(() => checkCallbackBase('https://afey.taile3d401.ts.net')).not.toThrow();
  });
});

describe('Daraja STK status query', () => {
  const realFetch = globalThis.fetch;
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string) => (String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 }) : new Response(JSON.stringify(body), { status }))) as typeof fetch;
  };
  it('treats "still under processing" (any form) and throttling as pending, and final codes as final', async () => {
    const { DarajaClient } = await import('../src/integrations/mpesa/daraja');
    const c = new DarajaClient({ environment: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passkey: 'p', transactionType: 'CustomerPayBillOnline' });
    try {
      answer(200, { ResponseCode: '0', ResultCode: '4999', ResultDesc: 'The transaction is still under processing' });
      expect((await c.stkQuery('ws_CO_1')).pending).toBe(true);
      answer(500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
      expect((await c.stkQuery('ws_CO_1')).pending).toBe(true);
      answer(500, { errorCode: '500.003.02', errorMessage: 'Spike arrest violation' });
      expect((await c.stkQuery('ws_CO_1')).pending).toBe(true);
      answer(200, { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
      expect(await c.stkQuery('ws_CO_1')).toMatchObject({ pending: false, resultCode: 0 });
      answer(200, { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
      expect(await c.stkQuery('ws_CO_1')).toMatchObject({ pending: false, resultCode: 1032 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
