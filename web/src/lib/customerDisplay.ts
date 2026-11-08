import { api } from './api';

/**
 * What the customer-facing display shows. The till publishes it; a second window on the same PC receives it
 * instantly through BroadcastChannel (works offline), and a paired tablet receives it through the server.
 */
export interface DisplayLine { name: string; qty: number; total: number; parts?: string[] }
export interface DisplayState {
  stage: 'idle' | 'order' | 'pay' | 'mpesa' | 'paid';
  orderNumber?: string;
  lines: DisplayLine[];
  subtotal: number; total: number; paid: number; balance: number;
  tip?: number; change?: number; method?: string; message?: string; receiptNumber?: string; payerName?: string;
}

const CHANNEL = 'chili-customer-display';
const LAST = 'chili.display.last';
const PAIRING = 'chili.till.displayPairing';
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
let last = '';
let timer: ReturnType<typeof setTimeout> | null = null;

export const getDisplayPairing = (): { id: string; name: string } | null => {
  try {
    return JSON.parse(localStorage.getItem(PAIRING) ?? 'null');
  } catch {
    return null;
  }
};
export const setDisplayPairing = (p: { id: string; name: string } | null) => {
  try {
    if (p) localStorage.setItem(PAIRING, JSON.stringify(p));
    else localStorage.removeItem(PAIRING);
  } catch {
    /* private mode */
  }
};

export function publishDisplay(state: DisplayState) {
  const json = JSON.stringify(state);
  if (json === last) return;
  last = json;
  bc?.postMessage(state);
  try {
    localStorage.setItem(LAST, json); // a display window opened later starts from the current screen
  } catch {
    /* ignore */
  }
  const pairing = getDisplayPairing();
  if (!pairing) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    api(`/display/screens/${pairing.id}`, { method: 'PUT', body: { state } }).catch(() => undefined);
  }, 250);
}

export function lastPublished(): DisplayState | null {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? 'null');
  } catch {
    return null;
  }
}
export function onDisplayMessage(fn: (s: DisplayState) => void) {
  const h = (e: MessageEvent) => fn(e.data as DisplayState);
  bc?.addEventListener('message', h);
  return () => bc?.removeEventListener('message', h);
}
