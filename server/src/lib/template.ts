/** Render {{variable}} placeholders. Unknown variables are left blank and reported. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') {
      missing.push(k);
      return '';
    }
    return String(v);
  });
  return { text, missing };
}

export const templateVariables = (tpl: string) =>
  Array.from(new Set(Array.from(tpl.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((m) => m[1])));

/** GSM-7 vs UCS-2 segment calculation for SMS length validation. */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  let gsm = true;
  let len = 0;
  for (const ch of text) {
    if (GSM7.includes(ch)) len += 1;
    else if (GSM7_EXT.includes(ch)) len += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', length: len, segments: len <= 160 ? 1 : Math.ceil(len / 153) };
  const ulen = [...text].length;
  return { encoding: 'UCS-2', length: ulen, segments: ulen <= 70 ? 1 : Math.ceil(ulen / 67) };
}
