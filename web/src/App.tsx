import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { AppShell } from '@/layout/AppShell';
import Login from '@/pages/Login';
import { ForgotPassword, ResetPassword } from '@/pages/PasswordReset';
import { Skeleton, Empty } from '@/components/ui';

const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const PosPage = lazy(() => import('@/pages/pos/PosPage'));
const TablesPage = lazy(() => import('@/pages/TablesPage'));
const OrdersBoard = lazy(() => import('@/pages/OrdersBoard'));
const StationPage = lazy(() => import('@/pages/StationPage'));
const ReservationsPage = lazy(() => import('@/pages/ReservationsPage'));
const DeliveryPage = lazy(() => import('@/pages/DeliveryPage'));
const InventoryPage = lazy(() => import('@/pages/InventoryPage'));
const RecipesPage = lazy(() => import('@/pages/RecipesPage'));
const PurchasingPage = lazy(() => import('@/pages/PurchasingPage'));
const CustomersPage = lazy(() => import('@/pages/CustomersPage'));
const StaffPage = lazy(() => import('@/pages/StaffPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const AccountingPage = lazy(() => import('@/pages/AccountingPage'));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const TrackOrder = lazy(() => import('@/pages/TrackOrder'));

function Loading() {
  return <div className="space-y-3 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
}

function Guard({ perms, children }: { perms?: string[]; children: ReactNode }) {
  const { session, loading, can } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (perms && !can(...perms)) return <Empty title="Not available" hint="Your role does not have access to this area. Ask a manager if you need it." />;
  return <>{children}</>;
}

function Home() {
  const { session, can } = useAuth();
  // Owners and managers land on the business dashboard; tills, kitchen and bar go straight to their screen.
  if (can('reports.sales')) return <Navigate to="/dashboard" replace />;
  if (can('orders.create')) return <Navigate to="/pos" replace />;
  if (can('kitchen.view')) return <Navigate to="/kitchen" replace />;
  if (can('bar.view')) return <Navigate to="/bar" replace />;
  if (can('reports.sales', 'reports.financial')) return <Navigate to="/reports" replace />;
  if (can('inventory.view')) return <Navigate to="/inventory" replace />;
  if (can('staff.view', 'attendance.view')) return <Navigate to="/staff" replace />;
  return <Empty title={`Welcome, ${session?.user.name}`} hint="Use the menu to get started." />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/track/:code" element={<TrackOrder />} />
          <Route element={<Guard><AppShell /></Guard>}>
            <Route index element={<Home />} />
            <Route path="dashboard" element={<Guard perms={['reports.sales']}><DashboardPage /></Guard>} />
            <Route path="pos" element={<Guard perms={['orders.create']}><PosPage /></Guard>} />
            <Route path="orders" element={<Guard perms={['orders.view']}><OrdersBoard /></Guard>} />
            <Route path="tables" element={<Guard perms={['tables.view']}><TablesPage /></Guard>} />
            <Route path="kitchen" element={<Guard perms={['kitchen.view']}><StationPage station="kitchen" /></Guard>} />
            <Route path="bar" element={<Guard perms={['bar.view']}><StationPage station="bar" /></Guard>} />
            <Route path="reservations" element={<Guard perms={['reservations.view']}><ReservationsPage /></Guard>} />
            <Route path="delivery" element={<Guard perms={['delivery.view']}><DeliveryPage /></Guard>} />
            <Route path="inventory" element={<Guard perms={['inventory.view']}><InventoryPage /></Guard>} />
            <Route path="recipes" element={<Guard perms={['recipes.manage', 'inventory.view']}><RecipesPage /></Guard>} />
            <Route path="purchasing" element={<Guard perms={['procurement.view']}><PurchasingPage /></Guard>} />
            <Route path="customers" element={<Guard perms={['customers.view']}><CustomersPage /></Guard>} />
            <Route path="staff" element={<Guard perms={['staff.view', 'attendance.view']}><StaffPage /></Guard>} />
            <Route path="reports" element={<Guard perms={['reports.sales', 'reports.inventory', 'reports.financial', 'reports.staff']}><ReportsPage /></Guard>} />
            <Route path="accounting" element={<Guard perms={['cash.session', 'accounting.view', 'expenses.manage']}><AccountingPage /></Guard>} />
            <Route path="integrations" element={<Guard perms={['integrations.manage']}><IntegrationsPage /></Guard>} />
            <Route path="settings" element={<Guard perms={['settings.manage', 'menu.manage', 'users.manage', 'tables.manage', 'audit.view']}><SettingsPage /></Guard>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
