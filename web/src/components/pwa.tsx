import { useEffect, useSyncExternalStore } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Download, RefreshCw, X } from 'lucide-react';
import { Button } from './ui';

// ───────────── Install ("Add to home screen") ─────────────

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The browser fires `beforeinstallprompt` once, often before React mounts, so it is captured at module load.
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

/** Whether this device can install the app, and a function that opens the browser's install dialog. */
export function useInstallPrompt() {
  const canInstall = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => !!deferred,
  );
  const install = async () => {
    if (!deferred) return false;
    const e = deferred;
    deferred = null;
    notify();
    await e.prompt();
    return (await e.userChoice).outcome === 'accepted';
  };
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
  return { canInstall, install, installed: isStandalone(), ios };
}

// ───────────── Updates and offline readiness ─────────────

const UPDATE_CHECK_MS = 60 * 60_000;

/**
 * Registers the service worker and shows a small banner when a new version is ready. The update is applied only
 * when someone taps "Update now", so an open order on a till is never interrupted by an automatic reload.
 */
export function PwaPrompts() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Tills stay open all day: look for a new version every hour.
      if (reg) setInterval(() => reg.update().catch(() => undefined), UPDATE_CHECK_MS);
    },
  });

  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setOfflineReady(false), 6000);
    return () => clearTimeout(t);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh && !offlineReady) return null;
  return (
    <div role="status" className="fixed inset-x-3 bottom-3 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-card p-3 shadow-lift sm:inset-x-auto sm:right-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-pale text-brand">
        {needRefresh ? <RefreshCw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
      </span>
      <p className="flex-1 text-sm">
        {needRefresh ? (
          <>
            <b>A new version is ready.</b> Update when you are between orders.
          </>
        ) : (
          'Chili POS is ready to start offline on this device.'
        )}
      </p>
      {needRefresh && (
        <Button size="sm" onClick={() => updateServiceWorker(true)}>
          Update now
        </Button>
      )}
      <button
        aria-label="Dismiss"
        className="rounded-lg p-1 text-ink-soft hover:bg-raised"
        onClick={() => {
          setNeedRefresh(false);
          setOfflineReady(false);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
