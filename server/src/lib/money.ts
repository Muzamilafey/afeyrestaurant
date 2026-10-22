/**
 * All monetary values are stored as integer minor units (cents) to avoid floating point drift.
 * Rates are stored in basis points (1600 = 16.00%).
 */
export const toMinor = (major: number) => Math.round(major * 100);
export const toMajor = (minor: number) => minor / 100;
export const bpsOf = (amount: number, bps: number) => Math.round((amount * bps) / 10000);
/** Tax portion contained within a tax-inclusive gross amount. */
export const inclusiveTax = (gross: number, bps: number) => Math.round(gross - gross / (1 + bps / 10000));
export const formatKes = (minor: number) =>
  `KSh ${(minor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
