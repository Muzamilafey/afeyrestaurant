/**
 * API client. Access tokens live in memory only; the refresh token is an httpOnly cookie that the
 * browser sends to /api/v1/auth/refresh. A 401 triggers one silent refresh and a retry.
 */
import { setServerReachable } from './connectivity';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let accessToken: string | null = null;
let branchId: string | null = null;
let onSessionExpired: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;
export const setActiveBranch = (id: string | null) => {
  branchId = id;
};
export const getActiveBranch = () => branchId;
export const setSessionExpiredHandler = (fn: () => void) => {
  onSessionExpired = fn;
};

type RefreshResult = ({ accessToken: string } & Record<string, unknown>) | null;
let inflight: Promise<RefreshResult> | null = null;

async function doRefresh(): Promise<RefreshResult> {
  const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'chili-pos' } });
  if (!res.ok) return null;
  const body = await res.json();
  accessToken = body.data.accessToken;
  return body.data;
}

/**
 * Refresh the session. Only one refresh runs at a time in this tab, and the Web Locks API serialises
 * refreshes across tabs, because the server rotates the refresh token on every use.
 */
export function refreshSession(): Promise<RefreshResult> {
  inflight ??= (async () => {
    try {
      const locks = (navigator as Navigator & { locks?: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> } }).locks;
      return locks ? await locks.request('chili-refresh', doRefresh) : await doRefresh();
    } catch {
      return null;
    }
  })().finally(() => setTimeout(() => (inflight = null), 0));
  return inflight;
}

async function tryRefresh() {
  refreshing ??= refreshSession().then((d) => !!d).finally(() => (refreshing = null));
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
  signal?: AbortSignal;
}

export async function api<T = any>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
  const headers: Record<string, string> = { 'X-Requested-With': 'chili-pos' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (branchId) headers['X-Branch-Id'] = branchId;
  const isForm = opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: isForm ? (opts.body as FormData) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'include', signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') setServerReachable(false);
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  // A gateway error from a proxy in front of the API (e.g. the server is down) also means "offline".
  setServerReachable(![502, 503, 504].includes(res.status) || res.headers.get('content-type')?.includes('application/json') === true);
  if (res.status === 401 && !retried && !path.startsWith('/auth/login')) {
    if (await tryRefresh()) return api<T>(path, opts, true);
    onSessionExpired?.();
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'ERROR', `Request failed (${res.status})`);
    return res as unknown as T;
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return body?.data as T;
}

export const get = <T = any>(path: string, query?: RequestOptions['query']) => api<T>(path, { query });
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} });

/** Download a CSV/blob endpoint with auth headers. */
export async function download(path: string, query: RequestOptions['query'], filename: string) {
  const res = await api<Response>(path, { query, raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Friendly message for an error, including validation details. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { fieldErrors?: Record<string, string[]> } | undefined;
    const fields = d?.fieldErrors ? Object.entries(d.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
    return fields ? `${e.message} — ${fields}` : e.message;
  }
  return (e as Error)?.message ?? 'Something went wrong';
}
