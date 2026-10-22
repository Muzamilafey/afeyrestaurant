/**
 * Settings that belong to this physical till (this browser), not to the user signed in: in a restaurant with several
 * tills each one prints receipts on the printer next to it. Stored locally; set from the account menu.
 */
const KEY = 'chili.till.receiptPrinter';

/** '' = automatic (the branch's first receipt printer), 'browser' = browser print dialog, otherwise a printer id. */
export function getTillReceiptPrinter(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}
export function setTillReceiptPrinter(v: string) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: falls back to automatic */
  }
}

interface PrinterLike { _id: string; role: string; connection: string; active: boolean; name: string }
/** The network printer this till should send receipts to, or null for the browser print dialog. */
export function pickReceiptPrinter<T extends PrinterLike>(printers: T[]): T | null {
  const choice = getTillReceiptPrinter();
  if (choice === 'browser') return null;
  const usable = printers.filter((p) => p.active && p.connection !== 'browser');
  return usable.find((p) => p._id === choice) ?? usable.find((p) => p.role === 'receipt') ?? null;
}
