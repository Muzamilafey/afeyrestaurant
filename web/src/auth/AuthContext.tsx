import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, post, refreshSession, setAccessToken, setActiveBranch, setSessionExpiredHandler } from '@/lib/api';

export interface Branch { id: string; name: string; code: string; settings?: Record<string, any> }
export interface Session {
  user: { id: string; name: string; email: string; role: { key: string; name: string } | null; isPlatformAdmin: boolean; mfaEnabled: boolean };
  tenant: { id: string; name: string; slug: string; status: string; branding?: { primaryColor?: string; logoUrl?: string }; settings?: Record<string, any> } | null;
  branches: Branch[];
  activeBranchId: string | null;
  permissions: string[];
  features: string[];
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  branch: Branch | null;
  login: (input: { email: string; password: string; tenantSlug?: string; mfaCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchBranch: (id: string) => void;
  can: (...perms: string[]) => boolean;
  hasFeature: (f: string) => boolean;
}

const Ctx = createContext<AuthState | null>(null);
const BRANCH_KEY = 'chili.branch';
const SESSION_CACHE = 'chili.session';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((data: Session & { accessToken?: string }) => {
    if (data.accessToken) setAccessToken(data.accessToken);
    const stored = localStorage.getItem(BRANCH_KEY);
    const b = data.branches.find((x) => x.id === stored)?.id ?? data.activeBranchId ?? data.branches[0]?.id ?? null;
    setActiveBranch(b);
    setBranchId(b);
    const { accessToken: _t, ...rest } = data;
    setSession(rest);
    // Cached (without tokens) so the POS can start offline with the last known identity and branch.
    localStorage.setItem(SESSION_CACHE, JSON.stringify(rest));
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setAccessToken(null);
      setSession(null);
    });
    refreshSession()
      .then((d) => {
        if (d) apply(d as never);
        else if (!navigator.onLine) {
          const cached = localStorage.getItem(SESSION_CACHE);
          if (cached) apply(JSON.parse(cached));
        }
      })
      .catch(() => {
        const cached = localStorage.getItem(SESSION_CACHE);
        if (cached && !navigator.onLine) apply(JSON.parse(cached));
      })
      .finally(() => setLoading(false));
  }, [apply]);

  const login = useCallback<AuthState['login']>(async (input) => {
    const data = await api<Session & { accessToken: string }>('/auth/login', { method: 'POST', body: input });
    apply(data);
  }, [apply]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } catch {
      /* offline logout still clears local state */
    }
    setAccessToken(null);
    localStorage.removeItem(SESSION_CACHE);
    setSession(null);
  }, []);

  const switchBranch = useCallback((id: string) => {
    localStorage.setItem(BRANCH_KEY, id);
    setActiveBranch(id);
    setBranchId(id);
  }, []);

  const value = useMemo<AuthState>(() => ({
    session,
    loading,
    branch: session?.branches.find((b) => b.id === branchId) ?? null,
    login,
    logout,
    switchBranch,
    can: (...perms) => !!session && (session.user.isPlatformAdmin || perms.some((p) => session.permissions.includes(p))),
    hasFeature: (f) => !!session && (session.user.isPlatformAdmin || session.features.includes(f)),
  }), [session, loading, branchId, login, logout, switchBranch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
