/**
 * Normalise Kenyan mobile numbers to MSISDN format (2547XXXXXXXX / 2541XXXXXXXX).
 * Accepts 07.., 01.., +2547.., 2547.., 7.. formats. Returns null when invalid.
 */
export function normalizeKePhone(input: string, defaultCountryCode = '254'): string | null {
  const digits = (input || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  let n = digits;
  if (n.startsWith('0') && n.length === 10) n = defaultCountryCode + n.slice(1);
  else if ((n.startsWith('7') || n.startsWith('1')) && n.length === 9) n = defaultCountryCode + n;
  if (defaultCountryCode === '254') return /^254(7|1)\d{8}$/.test(n) ? n : null;
  return n.length >= 10 && n.length <= 15 ? n : null;
}

export const maskPhone = (p?: string | null) => (p ? `${p.slice(0, 5)}***${p.slice(-3)}` : null);
