import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';

const schema = z.object({ tenantSlug: z.string().max(60).optional(), email: z.email('Enter a valid email'), password: z.string().min(1, 'Password is required'), mfaCode: z.string().optional() });
type Form = z.infer<typeof schema>;

/** Tenant is taken from the subdomain when present; otherwise the user enters the restaurant ID. */
function hostSlug() {
  const parts = window.location.hostname.split('.');
  return parts.length > 2 ? parts[0] : '';
}

export default function Login() {
  const { session, login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [needMfa, setNeedMfa] = useState(false);
  const slugFromHost = hostSlug();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { tenantSlug: slugFromHost || localStorage.getItem('chili.lastTenant') || '' } });
  if (session) return <Navigate to={from && from !== '/login' ? from : session.user.isPlatformAdmin ? '/platform' : '/'} replace />;

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await login({ email: v.email, password: v.password, tenantSlug: v.tenantSlug || undefined, mfaCode: v.mfaCode || undefined });
      if (v.tenantSlug) localStorage.setItem('chili.lastTenant', v.tenantSlug);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_REQUIRED') setNeedMfa(true);
      setError(errorMessage(e));
    }
  });

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-brand p-10 text-white lg:flex">
        <div className="flex items-center gap-3 text-xl font-bold"><span className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 text-2xl">🌶</span> Chili POS</div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">Run your restaurant & bar<br />from one place.</h1>
          <p className="mt-3 max-w-md text-white/80">Orders, kitchen and bar tickets, M-Pesa, inventory, staff attendance and reports — built for Kenyan hospitality.</p>
        </div>
        <p className="text-sm text-white/60">© {new Date().getFullYear()} Chili POS</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4" noValidate>
          <div>
            <h2 className="text-2xl font-bold">Sign in</h2>
            <p className="text-sm text-ink-soft">Use your staff account.</p>
          </div>
          {!slugFromHost && (
            <Field label="Restaurant ID" hint="Your restaurant’s subdomain, e.g. chili-demo. Leave blank for platform admin.">
              <Input autoCapitalize="none" {...register('tenantSlug')} />
            </Field>
          )}
          <Field label="Email" error={formState.errors.email?.message}><Input type="email" autoComplete="username" {...register('email')} /></Field>
          <Field label="Password" error={formState.errors.password?.message}><Input type="password" autoComplete="current-password" {...register('password')} /></Field>
          {needMfa && <Field label="Authenticator code"><Input inputMode="numeric" maxLength={6} autoFocus {...register('mfaCode')} /></Field>}
          {error && <p className="rounded-xl bg-danger-pale px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
          <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting}>Sign in</Button>
          <p className="text-center text-sm"><Link className="font-semibold text-brand" to="/forgot-password">Forgot password?</Link></p>
        </form>
      </div>
    </div>
  );
}
