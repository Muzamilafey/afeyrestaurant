/** Minimal fetch wrapper with timeout and JSON handling for provider calls. */
export class ProviderError extends Error {
  constructor(message: string, public status?: number, public body?: unknown, public retryable = true) {
    super(message);
  }
}

export async function httpJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, body };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Provider request timed out' : `Network error: ${(e as Error).message}`;
    throw new ProviderError(msg, undefined, undefined, true);
  } finally {
    clearTimeout(t);
  }
}

/** HTTP 5xx/429/network → retryable. Other 4xx → permanent. */
export const isRetryableStatus = (s: number) => s === 429 || s >= 500;
