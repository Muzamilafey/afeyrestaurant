import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, ShieldCheck, Copy } from 'lucide-react';
import { Button, Field, Input, Modal, Textarea, cx } from './ui';
import { ApiError, errorMessage } from '@/lib/api';

type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
interface FeedbackCtx {
  toast: (text: string, kind?: Toast['kind']) => void;
  confirm: (opts: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; reason?: boolean }) => Promise<{ ok: boolean; reason?: string }>;
  /** Run an action; if the server answers APPROVAL_REQUIRED, ask for a manager's email + PIN and retry. */
  withApproval: <T>(fn: (approval?: { approverEmail: string; pin: string }) => Promise<T>) => Promise<T>;
  handleError: (e: unknown) => void;
  /** In-app replacement for window.prompt: resolves with the entered text, or null when cancelled. */
  prompt: (opts: PromptOpts) => Promise<string | null>;
}
export interface PromptOpts {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  hint?: ReactNode;
  confirmLabel?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  multiline?: boolean;
  /** Shows the value read-only with a Copy button (e.g. a URL to paste elsewhere). */
  readOnly?: boolean;
  /** Minimum length before the confirm button enables (default 1; 0 allows empty). */
  minLength?: number;
}
const Ctx = createContext<FeedbackCtx | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirm] = useState<null | { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; reason?: boolean; resolve: (r: { ok: boolean; reason?: string }) => void }>(null);
  const [reason, setReason] = useState('');
  const [approvalState, setApproval] = useState<null | { message: string; resolve: (v: { approverEmail: string; pin: string } | null) => void }>(null);
  const [appr, setAppr] = useState({ approverEmail: '', pin: '' });
  const [promptState, setPrompt] = useState<null | (PromptOpts & { resolve: (v: string | null) => void })>(null);
  const [promptValue, setPromptValue] = useState('');
  const id = useRef(0);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const t = { id: ++id.current, kind, text };
    setToasts((x) => [...x, t]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const handleError = useCallback((e: unknown) => toast(errorMessage(e), 'error'), [toast]);
  const confirm = useCallback<FeedbackCtx['confirm']>((opts) => new Promise((resolve) => {
    setReason('');
    setConfirm({ ...opts, resolve });
  }), []);
  const prompt = useCallback<FeedbackCtx['prompt']>((opts) => new Promise((resolve) => {
    setPromptValue(opts.defaultValue ?? '');
    setPrompt({ ...opts, resolve });
  }), []);
  const closePrompt = (v: string | null) => {
    promptState?.resolve(v);
    setPrompt(null);
  };
  const promptOk = !!promptState && (promptState.readOnly || promptValue.trim().length >= (promptState.minLength ?? 1));
  const askApproval = (message: string) => new Promise<{ approverEmail: string; pin: string } | null>((resolve) => {
    setAppr((a) => ({ ...a, pin: '' }));
    setApproval({ message, resolve });
  });
  const withApproval = useCallback(async <T,>(fn: (approval?: { approverEmail: string; pin: string }) => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || !['APPROVAL_REQUIRED', 'APPROVAL_INVALID'].includes(e.code)) throw e;
      let message = e.message;
      for (let i = 0; i < 3; i++) {
        const a = await askApproval(message);
        if (!a) throw new ApiError(403, 'CANCELLED', 'Approval cancelled');
        try {
          return await fn(a);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'APPROVAL_INVALID') {
            message = err.message;
            continue;
          }
          throw err;
        }
      }
      throw e;
    }
  }, []);

  return (
    <Ctx.Provider value={{ toast, confirm, withApproval, handleError, prompt }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm shadow-lift', t.kind === 'error' ? 'border-danger/30' : 'border-line')}>
            {t.kind === 'success' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-brand" /> : t.kind === 'error' ? <AlertTriangle className="h-5 w-5 shrink-0 text-danger" /> : <Info className="h-5 w-5 shrink-0 text-ink-soft" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <Modal
        open={!!confirmState}
        onClose={() => { confirmState?.resolve({ ok: false }); setConfirm(null); }}
        title={confirmState?.title}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => { confirmState?.resolve({ ok: false }); setConfirm(null); }}>Cancel</Button>
            <Button variant={confirmState?.danger ? 'danger' : 'primary'} disabled={confirmState?.reason && reason.trim().length < 3} onClick={() => { confirmState?.resolve({ ok: true, reason }); setConfirm(null); }}>
              {confirmState?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div>{confirmState?.message}</div>
          {confirmState?.reason && (
            <Field label="Reason (required)">
              <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this needed?" />
            </Field>
          )}
        </div>
      </Modal>
      <Modal
        open={!!promptState}
        onClose={() => closePrompt(null)}
        title={promptState?.title}
        size="sm"
        footer={
          promptState?.readOnly ? (
            <>
              <Button variant="secondary" onClick={() => closePrompt(null)}>Close</Button>
              <Button icon={<Copy className="h-4 w-4" />} onClick={() => { navigator.clipboard?.writeText(promptValue).catch(() => undefined); toast('Copied'); closePrompt(promptValue); }}>Copy</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => closePrompt(null)}>Cancel</Button>
              <Button disabled={!promptOk} onClick={() => closePrompt(promptValue.trim())}>{promptState?.confirmLabel ?? 'OK'}</Button>
            </>
          )
        }
      >
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (promptOk) closePrompt(promptState?.readOnly ? promptValue : promptValue.trim()); }}>
          <Field label={promptState?.label ?? ''} hint={typeof promptState?.hint === 'string' ? promptState.hint : undefined}>
            {promptState?.multiline ? (
              <Textarea autoFocus value={promptValue} placeholder={promptState?.placeholder} onChange={(e) => setPromptValue(e.target.value)} />
            ) : (
              <Input autoFocus readOnly={promptState?.readOnly} onFocus={(e) => promptState?.readOnly && e.currentTarget.select()} inputMode={promptState?.inputMode} value={promptValue} placeholder={promptState?.placeholder} onChange={(e) => setPromptValue(e.target.value)} />
            )}
          </Field>
          {promptState?.hint && typeof promptState.hint !== 'string' && <div className="text-xs text-ink-soft">{promptState.hint}</div>}
          <button type="submit" hidden />
        </form>
      </Modal>
      <Modal
        open={!!approvalState}
        onClose={() => { approvalState?.resolve(null); setApproval(null); }}
        title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-brand" /> Manager approval</span>}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => { approvalState?.resolve(null); setApproval(null); }}>Cancel</Button>
            <Button disabled={!appr.approverEmail || appr.pin.length < 4} onClick={() => { approvalState?.resolve(appr); setApproval(null); }}>Approve</Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); approvalState?.resolve(appr); setApproval(null); }}>
          <p className="text-sm text-ink-soft">{approvalState?.message}. A manager must enter their email and PIN on this terminal.</p>
          <Field label="Manager email">
            <Input type="email" autoComplete="off" value={appr.approverEmail} onChange={(e) => setAppr({ ...appr, approverEmail: e.target.value })} />
          </Field>
          <Field label="PIN">
            <Input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={appr.pin} onChange={(e) => setAppr({ ...appr, pin: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <button type="submit" hidden />
        </form>
      </Modal>
    </Ctx.Provider>
  );
}

export function useFeedback() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useFeedback outside provider');
  return c;
}
