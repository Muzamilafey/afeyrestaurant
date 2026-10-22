import { clsx } from 'clsx';
import { X, Inbox, Loader2 } from 'lucide-react';
import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from 'react';

export const cx = clsx;

// Literal class names so Tailwind's content scanner keeps them.
const BTN_VARIANT = { primary: 'btn-primary', secondary: 'btn-secondary', ghost: 'btn-ghost', danger: 'btn-danger' } as const;
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean; icon?: ReactNode; size?: 'sm' | 'md' | 'lg' };
export function Button({ variant = 'primary', loading, icon, size = 'md', className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      className={cx(BTN_VARIANT[variant], size === 'sm' && '!min-h-[32px] !px-3 !text-xs', size === 'lg' && '!min-h-[52px] !text-base', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx('input', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cx('input pr-8', className)} {...p}>
      {children}
    </select>
  );
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx('input min-h-[80px] py-2', className)} {...p} />;
});

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-soft">{hint}</span> : null}
    </label>
  );
}

export function Card({ className, children, title, actions, padded = true }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx(padded && 'p-5')}>{children}</div>
    </section>
  );
}

const PILL: Record<string, string> = {
  green: 'bg-brand-pale text-brand-dark',
  gray: 'bg-page text-ink-soft border border-line',
  yellow: 'bg-warn-pale text-[#8a5a00]',
  red: 'bg-danger-pale text-danger',
  blue: 'bg-[#E3EEFB] text-[#2B5FA8]',
  dark: 'bg-ink text-white',
};
export function Pill({ color = 'gray', children, className }: { color?: keyof typeof PILL; children: ReactNode; className?: string }) {
  return <span className={cx('pill', PILL[color], className)}>{children}</span>;
}

const STATUS_COLOR: Record<string, keyof typeof PILL> = {
  open: 'blue', held: 'yellow', paid: 'green', voided: 'red', merged: 'gray', unpaid: 'gray', partial: 'yellow', refunded: 'red', partially_refunded: 'yellow',
  pending: 'yellow', accepted: 'blue', preparing: 'blue', ready: 'green', served: 'gray', completed: 'gray', cancelled: 'red', new: 'gray',
  available: 'green', occupied: 'blue', reserved: 'yellow', cleaning: 'gray', succeeded: 'green', failed: 'red', timeout: 'red', error: 'red',
  confirmed: 'green', seated: 'blue', no_show: 'red', ok: 'green', configured: 'yellow', unconfigured: 'gray', online: 'green', offline: 'red', unknown: 'gray',
  queued: 'yellow', sending: 'blue', sent: 'green', delivered: 'green', dead: 'red', skipped: 'gray', approved: 'green', rejected: 'red', draft: 'gray', submitted: 'blue',
  received: 'green', partially_received: 'yellow', trialing: 'yellow', trial: 'yellow', active: 'green', suspended: 'red', past_due: 'red', closed: 'gray', low: 'yellow', out: 'red',
};
export function StatusPill({ status }: { status?: string | null }) {
  if (!status) return null;
  return <Pill color={STATUS_COLOR[status] ?? 'gray'}>{status.replace(/_/g, ' ')}</Pill>;
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true">
      <div className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-lift sm:rounded-2xl', { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size])}>
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="rounded-lg p-1.5 text-ink-soft hover:bg-page" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-xl bg-line/60', className)} />;
}

export function Empty({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="rounded-2xl bg-page p-3 text-ink-soft">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="font-semibold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-soft">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-danger/30 bg-danger-pale px-4 py-3 text-sm text-danger">
      {(error as Error)?.message ?? 'Something went wrong'}
      {onRetry && (
        <button className="ml-3 font-semibold underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; hidden?: boolean }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="scroll-thin mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-white p-1">
      {tabs.filter((t) => !t.hidden).map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cx('whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold transition', value === t.id ? 'bg-brand text-white' : 'text-ink-soft hover:bg-page')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> { key: string; header: string; render: (row: T) => ReactNode; className?: string }
export function DataTable<T>({ rows, columns, loading, empty, rowKey, onRowClick }: { rows?: T[]; columns: Column<T>[]; loading?: boolean; empty?: ReactNode; rowKey: (r: T) => string; onRowClick?: (r: T) => void }) {
  if (loading) return <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (!rows?.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="scroll-thin -mx-5 overflow-x-auto px-5">
      <table className="table-base">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.className}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx(onRowClick && 'cursor-pointer hover:bg-page/60')}>
              {columns.map((c) => <td key={c.key} className={c.className}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'default' | 'green' | 'red' | 'yellow' }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      {icon && <div className={cx('rounded-xl p-2.5', tone === 'red' ? 'bg-danger-pale text-danger' : tone === 'yellow' ? 'bg-warn-pale text-[#8a5a00]' : 'bg-brand-pale text-brand-dark')}>{icon}</div>}
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
        <p className="truncate text-xl font-bold">{value}</p>
        {hint && <p className="text-xs text-ink-soft">{hint}</p>}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'opacity-50')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cx('relative h-6 w-11 rounded-full transition', checked ? 'bg-brand' : 'bg-line')}>
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
      {label}
    </label>
  );
}
