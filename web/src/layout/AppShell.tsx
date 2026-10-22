import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutGrid, Armchair, ChefHat, Wine, CalendarDays, Bike, Boxes, BookOpenText, Truck, Users, IdCard, BarChart3, Calculator, Plug, Settings, LogOut, Menu, Wifi, WifiOff, CloudUpload, Building2, X,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { cx } from '@/components/ui';
import { outbox, syncOutbox } from '@/lib/offline';
import { useRealtime } from '@/lib/socket';

const NAV = [
  { to: '/pos', label: 'POS / Menu', icon: LayoutGrid, perms: ['orders.create'] },
  { to: '/tables', label: 'Table Services', icon: Armchair, perms: ['tables.view'] },
  { to: '/kitchen', label: 'Kitchen Orders', icon: ChefHat, perms: ['kitchen.view'], feature: 'kds' },
  { to: '/bar', label: 'Bar Orders', icon: Wine, perms: ['bar.view'], feature: 'bar' },
  { to: '/reservations', label: 'Reservations', icon: CalendarDays, perms: ['reservations.view'], feature: 'reservations' },
  { to: '/delivery', label: 'Delivery', icon: Bike, perms: ['delivery.view'], feature: 'delivery' },
  { to: '/inventory', label: 'Inventory', icon: Boxes, perms: ['inventory.view'], feature: 'inventory' },
  { to: '/recipes', label: 'Recipes & Stock', icon: BookOpenText, perms: ['recipes.manage', 'inventory.view'], feature: 'inventory' },
  { to: '/purchasing', label: 'Purchasing', icon: Truck, perms: ['procurement.view'], feature: 'inventory' },
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
        <span className="pill bg-warn-pale text-[#8a5a00]" title="Offline sales waiting for synchronisation">
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
  const { session, branch, switchBranch, logout, can, hasFeature } = useAuth();
  const [open, setOpen] = useState(false);
  // Start collapsed on tablets so the POS gets the full width.
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1280);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const stations = [can('kitchen.view') ? 'kitchen' : null, can('bar.view') ? 'bar' : null].filter(Boolean) as string[];
  useRealtime(branch?.id ?? null, stations);
  if (!session) return null;
  const items = NAV.filter((n) => can(...n.perms) && (!n.feature || hasFeature(n.feature)));
  const isPos = loc.pathname.startsWith('/pos');

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 pb-4 pt-5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-lg font-black text-white">🌶</div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{session.tenant?.name ?? 'Chili POS'}</p>
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
      <div className="border-t border-line p-3">
        {!collapsed && (
          <div className="mb-2 rounded-xl bg-page px-3 py-2">
            <p className="truncate text-sm font-semibold">{session.user.name}</p>
            <p className="truncate text-xs text-ink-soft">{session.user.role?.name}</p>
          </div>
        )}
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft hover:bg-danger-pale hover:text-danger">
          <LogOut className="h-[18px] w-[18px]" /> {!collapsed && 'Logout'}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className={cx('hidden shrink-0 border-r border-line bg-white transition-all lg:block', collapsed ? 'w-[76px]' : 'w-60')}>{nav}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-ink/30" />
          <aside className="absolute left-0 top-0 h-full w-64 bg-white shadow-lift" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-3 top-5 rounded-lg p-1 text-ink-soft" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-3 sm:px-4">
          <button className="rounded-lg p-2 text-ink-soft hover:bg-page" onClick={() => (window.innerWidth >= 1024 ? setCollapsed(!collapsed) : setOpen(true))} aria-label="Toggle navigation">
            <Menu className="h-5 w-5" />
          </button>
          {session.branches.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-ink-soft" />
              <select className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm font-semibold" value={branch?.id ?? ''} onChange={(e) => switchBranch(e.target.value)}>
                {session.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <div className="flex-1" />
          <SyncBadge branchId={branch?.id ?? null} />
        </header>
        <main className={cx('min-h-0 flex-1', isPos ? 'overflow-hidden' : 'scroll-thin overflow-y-auto p-4 sm:p-6')}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
