import { config } from './config';

/** Calls the Chili POS API authenticated with the bridge token. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`${config.apiUrl}/api/v1${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'X-Bridge-Token': config.token, 'Content-Type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body?.data as T;
  } finally {
    clearTimeout(t);
  }
}
