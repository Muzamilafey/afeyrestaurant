import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Field, Input } from '@/components/ui';
import { post, errorMessage } from '@/lib/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form className="card w-full max-w-sm space-y-4 p-6" onSubmit={async (e) => { e.preventDefault(); try { const r = await post<{ message: string }>('/auth/password-reset/request', { email }); setMsg(r.message); } catch (err) { setMsg(errorMessage(err)); } }}>
        <h1 className="text-xl font-bold">Reset password</h1>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {msg && <p className="rounded-xl bg-page px-3 py-2 text-sm">{msg}</p>}
        <Button type="submit" className="w-full">Send reset link</Button>
        <Link to="/login" className="block text-center text-sm font-semibold text-brand">Back to sign in</Link>
      </form>
    </div>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form className="card w-full max-w-sm space-y-4 p-6" onSubmit={async (e) => { e.preventDefault(); try { await post('/auth/password-reset/confirm', { token: params.get('token'), newPassword: pw }); setDone(true); } catch (err) { setMsg(errorMessage(err)); } }}>
        <h1 className="text-xl font-bold">Choose a new password</h1>
        {done ? <p className="text-sm">Password updated. <Link to="/login" className="font-semibold text-brand">Sign in</Link></p> : (
          <>
            <Field label="New password" hint="At least 10 characters with upper/lower case and a number."><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            {msg && <p className="rounded-xl bg-danger-pale px-3 py-2 text-sm text-danger">{msg}</p>}
            <Button type="submit" className="w-full">Update password</Button>
          </>
        )}
      </form>
    </div>
  );
}
