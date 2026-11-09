import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Delete, Check, Lock, Mail, Loader2, WifiOff } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input, cx } from '@/components/ui';
import { ApiError, errorMessage, get, post } from '@/lib/api';

interface PublicBusiness { configured: boolean; name: string; logoUrl: string | null; primaryColor: string; setupRequiresToken: boolean }

export function BusinessMark({ name, logoUrl, size = 40, dark = false }: { name: string; logoUrl?: string | null; size?: number; dark?: boolean }) {
  return logoUrl ? (
    <img src={logoUrl} alt="" style={{ width: size, height: size }} className="rounded-xl object-cover" />
  ) : (
    <span style={{ width: size, height: size }} className={cx('grid place-items-center rounded-xl text-lg font-black', dark ? 'bg-brand text-white' : 'bg-brand text-white')}>{name.trim()[0]?.toUpperCase() ?? 'C'}</span>
  );
}

export default function Login() {
  const { session, terminalToken } = useAuth();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [mode, setMode] = useState<'pin' | 'email'>(terminalToken ? 'pin' : 'email');
  const { data: business, isLoading, isError, isFetching, refetch } = useQuery<PublicBusiness>({ queryKey: ['public-business'], queryFn: () => get('/business'), staleTime: 60_000 });
  useEffect(() => setMode(terminalToken ? 'pin' : 'email'), [terminalToken]);
  if (session) return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  // Signing in needs the server; say so instead of spinning forever (refetches automatically when back online).
  if (isError && !business)
    return (
      <div className="grid min-h-full place-items-center bg-[#111412] p-6 text-center text-white">
        <div className="max-w-sm space-y-3">
          <WifiOff className="mx-auto h-8 w-8 text-white/60" />
          <p className="text-lg font-semibold">Can’t reach the Chili POS server</p>
          <p className="text-sm text-white/60">{navigator.onLine ? 'The server is not responding. Check that it is running, then retry.' : 'This device is offline. Sign-in needs a connection — a till that was already signed in keeps working offline.'}</p>
          <Button onClick={() => refetch()} loading={isFetching}>Retry</Button>
        </div>
      </div>
    );
  if (isLoading || !business) return <div className="grid min-h-full place-items-center bg-[#111412]"><Loader2 className="h-6 w-6 animate-spin text-white/60" /></div>;
  if (!business.configured) return <FirstRunSetup business={business} onDone={() => refetch()} />;
  return mode === 'pin' && terminalToken ? <PinLogin business={business} onUseEmail={() => setMode('email')} /> : <EmailLogin business={business} onUsePin={terminalToken ? () => setMode('pin') : undefined} />;
}

// ───────────────────────── PIN sign-in (registered terminals) ─────────────────────────
function PinLogin({ business, onUseEmail }: { business: PublicBusiness; onUseEmail: () => void }) {
  const { pinLogin, setTerminalToken } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pinLogin(value);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TERMINAL_REQUIRED') {
        setTerminalToken(null);
        return;
      }
      setError(errorMessage(e));
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setPin('');
    } finally {
      setBusy(false);
    }
  }, [busy, pinLogin, setTerminalToken]);

  const press = useCallback((k: string) => {
    if (busy) return;
    setError(null);
    if (k === 'back') return setPin((p) => p.slice(0, -1));
    if (k === 'ok') return submit(pin);
    setPin((p) => {
      if (p.length >= 6) return p;
      const next = p + k;
      if (next.length === 6) submit(next); // 6-digit PINs submit automatically
      return next;
    });
  }, [busy, pin, submit]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') press('ok');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [press]);

  return (
    <div className="grid min-h-full place-items-center bg-[#0B0D0C] p-4 sm:p-6">
      <section className="flex w-full max-w-md flex-col items-center rounded-[28px] border border-white/10 bg-[#111412] px-6 py-8 text-white sm:px-10">
        <header className="mb-8 flex items-center gap-3 self-start">
          <BusinessMark name={business.name} logoUrl={business.logoUrl} dark />
          <p className="truncate font-bold">{business.name}</p>
        </header>
        <Lock className="mb-3 h-8 w-8 text-white/60" />
        <h1 className="text-2xl font-bold">Enter your PIN</h1>
        <p className="mt-1 text-sm text-white/50">Use your staff PIN to sign in.</p>
        <div className={cx('my-6 flex min-h-5 gap-4', shake && 'animate-[shake_0.4s]')} aria-live="polite" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, Math.min(6, pin.length + (pin.length >= 4 ? 1 : 0))) }).map((_, i) => (
            <span key={i} className={cx('h-3.5 w-3.5 rounded-full transition', i < pin.length ? 'bg-white' : 'bg-white/20')} />
          ))}
        </div>
        <p className={cx('mb-4 h-5 text-center text-sm', error ? 'text-[#FF8A8A]' : 'text-white/40')} role={error ? 'alert' : undefined}>{busy ? 'Signing in…' : error ?? '4 to 6 digits'}</p>
        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <Key key={d} onClick={() => press(d)}>{d}</Key>)}
          <Key onClick={() => press('ok')} disabled={pin.length < 4 || busy} className="bg-brand hover:bg-brand-dark" label="Sign in"><Check className="h-6 w-6" /></Key>
          <Key onClick={() => press('0')} disabled={busy}>0</Key>
          <Key onClick={() => press('back')} disabled={busy} className="bg-transparent hover:bg-white/10" label="Delete"><Delete className="h-6 w-6" /></Key>
        </div>
        <button onClick={onUseEmail} className="mt-7 inline-flex items-center gap-2 text-sm text-white/60 hover:text-white"><Mail className="h-4 w-4" /> Sign in with email instead</button>
      </section>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}`}</style>
    </div>
  );
}

function Key({ children, onClick, disabled, className, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; className?: string; label?: string }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={cx('grid h-[72px] w-[72px] select-none place-items-center rounded-2xl bg-white/10 text-2xl font-medium text-white transition hover:bg-white/15 active:scale-95 disabled:opacity-30 sm:h-20 sm:w-20', className)}>
      {children}
    </button>
  );
}

// ───────────────────────── Email sign-in ─────────────────────────

const schema = z.object({ email: z.email('Enter a valid email'), password: z.string().min(1, 'Password is required'), mfaCode: z.string().optional() });
type Form = z.infer<typeof schema>;

function EmailLogin({ business, onUsePin }: { business: PublicBusiness; onUsePin?: () => void }) {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [needMfa, setNeedMfa] = useState(false);
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(schema) });
  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await login({ email: v.email, password: v.password, mfaCode: v.mfaCode || undefined });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_REQUIRED') setNeedMfa(true);
      setError(errorMessage(e));
    }
  });
  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-brand p-10 text-white lg:flex">
        <div className="flex items-center gap-3 text-xl font-bold"><BusinessMark name={business.name} logoUrl={business.logoUrl} size={44} /> {business.name}</div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">Good food.<br />Fast service.</h1>
          <p className="mt-3 max-w-md text-white/80">Orders, kitchen and bar tickets, M-Pesa, inventory, staff attendance and reports in one place.</p>
        </div>
        <p className="text-sm text-white/60">Powered by Chili POS</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4" noValidate>
          <div className="flex items-center gap-3 lg:hidden"><BusinessMark name={business.name} logoUrl={business.logoUrl} /><span className="font-bold">{business.name}</span></div>
          <div>
            <h2 className="text-2xl font-bold">Sign in</h2>
            <p className="text-sm text-ink-soft">Managers and back-office staff sign in with email.</p>
          </div>
          <Field label="Email" error={formState.errors.email?.message}><Input type="email" autoComplete="username" {...register('email')} /></Field>
          <Field label="Password" error={formState.errors.password?.message}><Input type="password" autoComplete="current-password" {...register('password')} /></Field>
          {needMfa && <Field label="Authenticator code"><Input inputMode="numeric" maxLength={6} autoFocus {...register('mfaCode')} /></Field>}
          {error && <p className="rounded-xl bg-danger-pale px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
          <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting}>Sign in</Button>
          <div className="flex justify-between text-sm">
            <Link className="font-semibold text-brand" to="/forgot-password">Forgot password?</Link>
            {onUsePin && <button type="button" className="font-semibold text-brand" onClick={onUsePin}>Use PIN instead</button>}
          </div>
          {!onUsePin && <p className="rounded-xl bg-page px-3 py-2 text-xs text-ink-soft">Want staff to sign in with a PIN on this device? A manager signs in once, then chooses <b>Use this device for PIN sign-in</b> from the account menu.</p>}
        </form>
      </div>
    </div>
  );
}

// ───────────────────────── First-run setup ─────────────────────────

function FirstRunSetup({ business, onDone }: { business: PublicBusiness; onDone: () => void }) {
  const [f, setF] = useState({ setupToken: '', name: '', branchName: 'Main', branchCode: 'MAIN', ownerName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return; // no double submissions
    setBusy(true);
    setError(null);
    try {
      await post('/setup', { setupToken: f.setupToken || undefined, name: f.name, branch: { name: f.branchName, code: f.branchCode }, owner: { name: f.ownerName, email: f.email, password: f.password } });
      onDone();
    } catch (err) {
      // Another tab or a retried request already finished setup — continue to sign-in instead of showing an error.
      if (err instanceof ApiError && err.code === 'ALREADY_SET_UP') return onDone();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-lg space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-bold">Welcome to Chili POS</h1>
          <p className="text-sm text-ink-soft">Set up your restaurant. You can change the name and add your logo later in Settings.</p>
        </div>
        {business.setupRequiresToken && <Field label="Setup token" hint="From the server’s SETUP_TOKEN setting"><Input value={f.setupToken} onChange={set('setupToken')} /></Field>}
        <Field label="Business name"><Input value={f.name} onChange={set('name')} placeholder="e.g. Afey Restaurant" /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="First branch"><Input value={f.branchName} onChange={set('branchName')} /></Field><Field label="Branch code"><Input value={f.branchCode} onChange={(e) => setF({ ...f, branchCode: e.target.value.toUpperCase() })} /></Field></div>
        <Field label="Owner name"><Input value={f.ownerName} onChange={set('ownerName')} /></Field>
        <Field label="Owner email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Password" hint="At least 10 characters with upper/lower case and a number"><Input type="password" value={f.password} onChange={set('password')} /></Field>
        {error && <p className="rounded-xl bg-danger-pale px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={busy}>Create my restaurant</Button>
      </form>
    </div>
  );
}
