import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, LayoutGrid, Armchair, ChefHat, Wine, CalendarDays, Bike, Boxes, BookOpenText, Truck, Users, IdCard, BarChart3, Calculator, Plug, Settings, LogOut, Menu, Wifi, WifiOff, CloudUpload, Building2, X, Lock, Sun, Moon, ClipboardList,
} from 'lucide-react';
import { useAuth, shiftStaff } from '@/auth/AuthContext';
import { cx } from '@/components/ui';
import { outbox, syncOutbox } from '@/lib/offline';
import { useRealtime } from '@/lib/socket';
import { BusinessMark } from '@/pages/Login';
import { AccountMenu } from './AccountMenu';
import { useTheme } from '@/lib/theme';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, perms: ['reports.sales'] },
  { to: '/pos', label: 'POS / Menu', icon: LayoutGrid, perms: ['orders.create'] },
  { to: '/orders', label: 'Orders', icon: ClipboardList, perms: ['orders.view'] },
  { to: '/tables', label: 'Table Services', icon: Armchair, perms: ['tables.view'] },
  { to: '/kitchen', label: 'Kitchen Orders', icon: ChefHat, perms: ['kitchen.view'] },
  { to: '/bar', label: 'Bar Orders', icon: Wine, perms: ['bar.view'] },
  { to: '/reservations', label: 'Reservations', icon: CalendarDays, perms: ['reservations.view'] },
  { to: '/delivery', label: 'Delivery', icon: Bike, perms: ['delivery.view'] },
  { to: '/inventory', label: 'Inventory', icon: Boxes, perms: ['inventory.view'] },
  { to: '/recipes', label: 'Recipes & Stock', icon: BookOpenText, perms: ['recipes.manage', 'inventory.view'] },
  { to: '/purchasing', label: 'Purchasing', icon: Truck, perms: ['procurement.view'] },
  { to: '/customers', label: 'Customers', icon: Users, perms: ['customers.view'] },
  { to: '/staff', label: 'Staff & Attendance', icon: IdCard, perms: ['staff.view', 'attendance.view'] },
  { to: '/reports', label: 'Reports', icon: BarChart3, perms: ['reports.sales', 'reports.inventory', 'reports.financial', 'reports.staff'] },
  { to: '/accounting', label: 'Accounting', icon: Calculator, perms: ['cash.session', 'accounting.view', 'expenses.manage'] },
  { to: '/integrations', label: 'Integrations', icon: Plug, perms: ['integrations.manage'] },
  { to: '/settings', label: 'Settings', icon: Settings, perms: ['settings.manage', 'menu.manage', 'users.manage', 'tables.manage', 'audit.view'] },
];

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function SyncBadge({ branchId }: { branchId: string | null }) {
  const online = useOnline();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const refresh = () => outbox('pending').then((o) => setPending(o.length)).catch(() => setPending(0));
    refresh();
    window.addEventListener('chili:outbox', refresh);
    return () => window.removeEventListener('chili:outbox', refresh);
  }, []);
  useEffect(() => {
    if (online && branchId && pending) syncOutbox(branchId).catch(() => undefined);
    const t = setInterval(() => online && branchId && syncOutbox(branchId).catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [online, branchId, pending]);
  return (
    <div className="flex items-center gap-2">
      {pending > 0 && (
        <span className="pill bg-warn-pale text-warn-ink" title="Offline sales waiting for synchronisation">
          <CloudUpload className="h-3.5 w-3.5" /> {pending} pending sync
        </span>
      )}
      <span className={cx('pill', online ? 'bg-brand-pale text-brand-dark' : 'bg-danger-pale text-danger')}>
        {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

export function AppShell() {
  const { session, branch, switchBranch, logout, can, terminalToken } = useAuth();
  const [account, setAccount] = useState(false);
  const { theme, toggle } = useTheme();
  useIdleLock(!!terminalToken && !!session, logout);
  const [open, setOpen] = useState(false);
  // Start collapsed on tablets so the POS gets the full width.
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1280);
  const loc = useLocation();
  const navigate = useNavigate();
  const switchTo = async (id: string) => {
    await logout();
    navigate('/login', { state: { preselect: id } });
  };
  useEffect(() => setOpen(false), [loc.pathname]);
  const stations = [can('kitchen.view') ? 'kitchen' : null, can('bar.view') ? 'bar' : null].filter(Boolean) as string[];
  useRealtime(branch?.id ?? null, stations);
  if (!session) return null;
  const items = NAV.filter((n) => can(...n.perms));
  const isPos = loc.pathname.startsWith('/pos');

  // The desktop sidebar can be collapsed to icons; the mobile slide-out menu always shows the full names.
  const renderNav = (collapsed: boolean) => (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 pb-4 pt-5">
        <BusinessMark name={session.business?.name ?? 'Chili POS'} logoUrl={session.business?.branding?.logoUrl} />
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{session.business?.name ?? 'Chili POS'}</p>
            <p className="truncate text-xs text-ink-soft">{branch?.name ?? 'No branch'}</p>
          </div>
        )}
      </div>
      <div className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-3">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} title={n.label} className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition', isActive ? 'bg-brand-pale text-brand-dark' : 'text-ink-soft hover:bg-page hover:text-ink')}>
            <n.icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="truncate">{n.label}</span>}
          </NavLink>
        ))}
      </div>
      {terminalToken && !collapsed && shiftStaff().length > 0 && (
        <div className="px-4 pb-2">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Shift</p>
          <div className="flex flex-col items-start gap-1.5">
            {shiftStaff().map((s, i) => (
              <button key={s.id} onClick={() => s.id !== session.user.id && switchTo(s.id)} title={s.id === session.user.id ? 'Signed in' : `Switch to ${s.name}`} className={cx('flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs', s.id === session.user.id ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line hover:border-brand/50')}>
                <span className={cx('grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold', ['bg-[#C9C6F2] text-[#2E2A6B]', 'bg-[#C3EBDD] text-[#0F5137]', 'bg-[#F2C9D4] text-[#6B1F33]'][i % 3])}>{s.name[0]}</span>
                {s.name.split(' ')[0]} {s.name.split(' ').slice(-1)[0]?.[0]}.
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="border-t border-line p-3">
        <button onClick={() => setAccount(true)} title="My account & PIN" className={cx('mb-2 flex w-full items-center gap-2 rounded-xl bg-page px-3 py-2 text-left hover:bg-brand-pale', collapsed && 'justify-center px-0')}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-pale text-sm font-bold text-brand-dark">{session.user.name[0]}</span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{session.user.name}</span>
              <span className="block truncate text-xs text-ink-soft">{session.user.role?.name} · My PIN</span>
            </span>
          )}
        </button>
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft hover:bg-danger-pale hover:text-danger">
          {terminalToken ? <Lock className="h-[18px] w-[18px]" /> : <LogOut className="h-[18px] w-[18px]" />} {!collapsed && (terminalToken ? 'Switch user' : 'Logout')}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className={cx('hidden shrink-0 border-r border-line bg-card transition-all lg:block', collapsed ? 'w-[76px]' : 'w-60')}>{renderNav(collapsed)}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-card shadow-lift" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-3 top-5 rounded-lg p-1 text-ink-soft" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
            {renderNav(false)}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-card px-3 sm:px-4">
          <button className="rounded-lg p-2 text-ink-soft hover:bg-page" onClick={() => (window.innerWidth >= 1024 ? setCollapsed(!collapsed) : setOpen(true))} aria-label="Toggle navigation">
            <Menu className="h-5 w-5" />
          </button>
          {session.branches.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-ink-soft" />
              <select className="rounded-lg border border-line bg-card px-2 py-1.5 text-sm font-semibold" value={branch?.id ?? ''} onChange={(e) => switchBranch(e.target.value)}>
                {session.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <div className="flex-1" />
          <SyncBadge branchId={branch?.id ?? null} />
          <button onClick={toggle} className="rounded-xl p-2 text-ink-soft hover:bg-page hover:text-ink" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
            {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          {terminalToken && (
            <button onClick={logout} className="hidden items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-sm font-semibold sm:flex" title="Lock and switch user">
              <Lock className="h-4 w-4" /> Switch user
            </button>
          )}
        </header>
        <main className={cx('min-h-0 flex-1', isPos ? 'overflow-hidden' : 'scroll-thin overflow-y-auto p-4 sm:p-6')}>
          <Outlet />
        </main>
      </div>
      {account && <AccountMenu onClose={() => setAccount(false)} />}
    </div>
  );
}

/** Shared terminals lock back to the PIN screen after a period without interaction. */
function useIdleLock(enabled: boolean, lock: () => void, minutes = 5) {
  useEffect(() => {
    if (!enabled) return;
    let t = setTimeout(lock, minutes * 60_000);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(lock, minutes * 60_000);
    };
    const events = ['pointerdown', 'keydown', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [enabled, lock, minutes]);
}
