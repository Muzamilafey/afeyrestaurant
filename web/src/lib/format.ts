/** All amounts from the API are integer cents. */
export const money = (cents: number | null | undefined, withSymbol = true) => {
  const v = (cents ?? 0) / 100;
  const s = v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? `KSh ${s}` : s;
};
export const toCents = (major: string | number) => Math.round(Number(major) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);
export const dateTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const date = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—');
export const time = (d?: string | Date | null) => (d ? new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '—');
export const elapsed = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
