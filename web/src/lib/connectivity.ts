import { useSyncExternalStore } from 'react';

/**
 * Is the Chili POS server reachable? `navigator.onLine` only says whether the device has a network: with a hosted
 * server the Wi-Fi is often still up while the internet is down. So reachability is decided by the server itself:
 * a light health check (every 10 s while online, every 5 s while offline, and immediately when the device's network
 * changes), plus every API call — a network failure means offline, any response means online.
 */
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setServerReachable(v: boolean) {
  if (v === online) return;
  online = v;
  emit();
  window.dispatchEvent(new Event(v ? 'chili:online' : 'chili:offline'));
}
export const isServerReachable = () => online;

let timer: ReturnType<typeof setTimeout> | undefined;
async function check() {
  clearTimeout(timer);
  if (typeof navigator !== 'undefined' && !navigator.onLine) setServerReachable(false);
  else {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch('/api/v1/health', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      setServerReachable(res.ok);
    } catch {
      setServerReachable(false);
    }
  }
  timer = setTimeout(check, online ? 10_000 : 5_000);
}

let started = false;
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void check());
  window.addEventListener('offline', () => setServerReachable(false));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check());
  void check();
}

/** True while the server answers. Re-renders when the connection drops or returns. */
export function useOnline() {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => online,
    () => true,
  );
}
