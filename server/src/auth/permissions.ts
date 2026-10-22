/**
 * Granular permission codes. Every sensitive backend route declares the permission it requires;
 * the frontend only uses these to decide what to show — enforcement is server side.
 */
export const PERMISSIONS = {
  // POS & orders
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_VOID_ITEM: 'orders.void_item',
  ORDERS_VOID_SENT_ITEM: 'orders.void_sent_item',
  ORDERS_VOID: 'orders.void',
  ORDERS_DISCOUNT: 'orders.discount',
  ORDERS_DISCOUNT_APPROVE: 'orders.discount_approve',
  ORDERS_TRANSFER: 'orders.transfer',
  ORDERS_MERGE: 'orders.merge',
  ORDERS_COMPLIMENTARY: 'orders.complimentary',
  PAYMENTS_RECEIVE: 'payments.receive',
  PAYMENTS_MANUAL_CONFIRM: 'payments.manual_confirm',
  PAYMENTS_REFUND: 'payments.refund',
  PAYMENTS_CREDIT_SALE: 'payments.credit_sale',
  RECEIPTS_REPRINT: 'receipts.reprint',
  // Stations
  KITCHEN_VIEW: 'kitchen.view',
  KITCHEN_UPDATE: 'kitchen.update',
  BAR_VIEW: 'bar.view',
  BAR_UPDATE: 'bar.update',
  // Tables & reservations & delivery
  TABLES_VIEW: 'tables.view',
  TABLES_MANAGE: 'tables.manage',
  RESERVATIONS_VIEW: 'reservations.view',
  RESERVATIONS_MANAGE: 'reservations.manage',
  DELIVERY_VIEW: 'delivery.view',
  DELIVERY_MANAGE: 'delivery.manage',
  // Menu
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  MENU_PRICE_CHANGE: 'menu.price_change',
  // Inventory
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_ADJUST_APPROVE: 'inventory.adjust_approve',
  INVENTORY_OVERRIDE: 'inventory.override',
  RECIPES_MANAGE: 'recipes.manage',
  PROCUREMENT_VIEW: 'procurement.view',
  PROCUREMENT_MANAGE: 'procurement.manage',
  PROCUREMENT_APPROVE: 'procurement.approve',
  // Cash & accounting
  CASH_SESSION: 'cash.session',
  CASH_SESSION_VIEW_ALL: 'cash.session_view_all',
  EXPENSES_MANAGE: 'expenses.manage',
  ACCOUNTING_VIEW: 'accounting.view',
  // Customers
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_MANAGE: 'customers.manage',
  CUSTOMERS_NOTES: 'customers.notes',
  LOYALTY_MANAGE: 'loyalty.manage',
  // Staff
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MANAGE: 'attendance.manage',
  ATTENDANCE_APPROVE: 'attendance.approve',
  BIOMETRIC_ENROLL: 'biometric.enroll',
  DEVICES_MANAGE: 'devices.manage',
  // Reports
  REPORTS_SALES: 'reports.sales',
  REPORTS_INVENTORY: 'reports.inventory',
  REPORTS_FINANCIAL: 'reports.financial',
  REPORTS_STAFF: 'reports.staff',
  // Administration
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  BRANCHES_MANAGE: 'branches.manage',
  SETTINGS_MANAGE: 'settings.manage',
  TERMINALS_MANAGE: 'terminals.manage',
  INTEGRATIONS_MANAGE: 'integrations.manage',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  AUDIT_VIEW: 'audit.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];
const TENANT_PERMISSIONS = ALL_PERMISSIONS;

const P = PERMISSIONS;

/** Default system roles. Tenants may clone and customise these. */
export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: Permission[]; branchScoped: boolean }> = {
  owner: {
    name: 'Restaurant Owner',
    description: 'Full access to all branches and business-wide settings',
    permissions: TENANT_PERMISSIONS,
    branchScoped: false,
  },
  general_manager: {
    name: 'General Manager',
    description: 'Manages operations across all branches',
    permissions: TENANT_PERMISSIONS.filter((p) => p !== P.ROLES_MANAGE),
    branchScoped: false,
  },
  branch_manager: {
    name: 'Branch Manager',
    description: 'Manages one or more assigned branches; approves voids, discounts and adjustments',
    permissions: [
      P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_UPDATE, P.ORDERS_VOID_ITEM, P.ORDERS_VOID_SENT_ITEM, P.ORDERS_VOID,
      P.ORDERS_DISCOUNT, P.ORDERS_DISCOUNT_APPROVE, P.ORDERS_TRANSFER, P.ORDERS_MERGE, P.ORDERS_COMPLIMENTARY,
      P.PAYMENTS_RECEIVE, P.PAYMENTS_MANUAL_CONFIRM, P.PAYMENTS_REFUND, P.PAYMENTS_CREDIT_SALE, P.RECEIPTS_REPRINT,
      P.KITCHEN_VIEW, P.KITCHEN_UPDATE, P.BAR_VIEW, P.BAR_UPDATE, P.TABLES_VIEW, P.TABLES_MANAGE,
      P.RESERVATIONS_VIEW, P.RESERVATIONS_MANAGE, P.DELIVERY_VIEW, P.DELIVERY_MANAGE, P.MENU_VIEW, P.MENU_MANAGE,
      P.INVENTORY_VIEW, P.INVENTORY_MANAGE, P.INVENTORY_ADJUST, P.INVENTORY_ADJUST_APPROVE, P.INVENTORY_OVERRIDE,
      P.RECIPES_MANAGE, P.PROCUREMENT_VIEW, P.PROCUREMENT_MANAGE, P.PROCUREMENT_APPROVE, P.CASH_SESSION,
      P.CASH_SESSION_VIEW_ALL, P.EXPENSES_MANAGE, P.CUSTOMERS_VIEW, P.CUSTOMERS_MANAGE, P.CUSTOMERS_NOTES,
      P.LOYALTY_MANAGE, P.STAFF_VIEW, P.ATTENDANCE_VIEW, P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE,
      P.BIOMETRIC_ENROLL, P.REPORTS_SALES, P.REPORTS_INVENTORY, P.REPORTS_STAFF, P.AUDIT_VIEW, P.TERMINALS_MANAGE,
    ],
    branchScoped: true,
  },
  cashier: {
    name: 'Cashier',
    description: 'Creates sales and receives payments',
    permissions: [
      P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_UPDATE, P.ORDERS_VOID_ITEM, P.ORDERS_DISCOUNT, P.ORDERS_TRANSFER,
      P.PAYMENTS_RECEIVE, P.CASH_SESSION, P.TABLES_VIEW, P.MENU_VIEW, P.CUSTOMERS_VIEW, P.RESERVATIONS_VIEW,
      P.DELIVERY_VIEW, P.KITCHEN_VIEW, P.BAR_VIEW,
    ],
    branchScoped: true,
  },
  waiter: {
    name: 'Waiter',
    description: 'Takes and updates table orders',
    permissions: [
      P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_UPDATE, P.ORDERS_VOID_ITEM, P.ORDERS_TRANSFER, P.TABLES_VIEW,
      P.MENU_VIEW, P.RESERVATIONS_VIEW, P.CUSTOMERS_VIEW,
    ],
    branchScoped: true,
  },
  bartender: {
    name: 'Bartender',
    description: 'Prepares drinks against authorised bar tickets',
    permissions: [P.BAR_VIEW, P.BAR_UPDATE, P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_UPDATE, P.MENU_VIEW, P.TABLES_VIEW, P.INVENTORY_VIEW],
    branchScoped: true,
  },
  chef: {
    name: 'Kitchen Staff / Chef',
    description: 'Works the kitchen display; no payment access',
    permissions: [P.KITCHEN_VIEW, P.KITCHEN_UPDATE, P.MENU_VIEW, P.INVENTORY_VIEW],
    branchScoped: true,
  },
  storekeeper: {
    name: 'Storekeeper',
    description: 'Manages stock movements and counts',
    permissions: [P.INVENTORY_VIEW, P.INVENTORY_MANAGE, P.INVENTORY_ADJUST, P.PROCUREMENT_VIEW, P.REPORTS_INVENTORY, P.MENU_VIEW],
    branchScoped: true,
  },
  procurement: {
    name: 'Procurement Officer',
    description: 'Raises purchase orders and manages suppliers',
    permissions: [P.PROCUREMENT_VIEW, P.PROCUREMENT_MANAGE, P.INVENTORY_VIEW, P.REPORTS_INVENTORY],
    branchScoped: false,
  },
  accountant: {
    name: 'Accountant',
    description: 'Financial reports, reconciliation and expenses',
    permissions: [
      P.ACCOUNTING_VIEW, P.REPORTS_SALES, P.REPORTS_FINANCIAL, P.REPORTS_INVENTORY, P.CASH_SESSION_VIEW_ALL,
      P.EXPENSES_MANAGE, P.PROCUREMENT_VIEW, P.ORDERS_VIEW, P.CUSTOMERS_VIEW,
    ],
    branchScoped: false,
  },
  hr: {
    name: 'HR / Attendance Officer',
    description: 'Staff records, shifts and attendance',
    permissions: [
      P.STAFF_VIEW, P.STAFF_MANAGE, P.ATTENDANCE_VIEW, P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE, P.BIOMETRIC_ENROLL,
      P.DEVICES_MANAGE, P.REPORTS_STAFF,
    ],
    branchScoped: false,
  },
  auditor: {
    name: 'Auditor',
    description: 'Read-only access to reports and audit trail',
    permissions: [
      P.ORDERS_VIEW, P.REPORTS_SALES, P.REPORTS_FINANCIAL, P.REPORTS_INVENTORY, P.REPORTS_STAFF, P.AUDIT_VIEW,
      P.ACCOUNTING_VIEW, P.INVENTORY_VIEW, P.CASH_SESSION_VIEW_ALL,
    ],
    branchScoped: false,
  },
};
