import { Role, Tenant } from '../models';
import { PERMISSIONS as P, SYSTEM_ROLES } from '../auth/permissions';

/**
 * One-time changes for businesses set up before a feature existed. Each runs once per business (a marker in settings),
 * so a later change an admin makes to a role is never undone at the next restart.
 */
export async function runUpgrades() {
  // orders.view_all (see every open order on the POS): give it to the roles that always saw everything.
  const pending = await Tenant.find({ 'settings.ordersViewAllUpgraded': { $ne: true } }).select('_id').lean();
  for (const t of pending) {
    await Role.updateMany({ tenantId: t._id, key: { $in: ['owner', 'general_manager', 'branch_manager'] } }, { $addToSet: { permissions: P.ORDERS_VIEW_ALL } });
    await Tenant.updateOne({ _id: t._id }, { $set: { 'settings.ordersViewAllUpgraded': true } });
  }

  // Existing system roles need accommodation access once; later admin role edits remain untouched.
  const accommodationPending = await Tenant.find({ 'settings.accommodationRolesUpgraded': { $ne: true } }).select('_id').lean();
  for (const t of accommodationPending) {
    const receptionist = SYSTEM_ROLES.receptionist;
    await Role.updateOne(
      { tenantId: t._id, key: 'receptionist' },
      { $setOnInsert: { name: receptionist.name, description: receptionist.description, permissions: receptionist.permissions, branchScoped: receptionist.branchScoped, system: true } },
      { upsert: true },
    );
    await Role.updateMany(
      { tenantId: t._id, key: { $in: ['owner', 'general_manager', 'branch_manager'] } },
      { $addToSet: { permissions: { $each: [P.ACCOMMODATION_VIEW, P.ACCOMMODATION_MANAGE] } } },
    );
    await Tenant.updateOne({ _id: t._id }, { $set: { 'settings.accommodationRolesUpgraded': true } });
  }

  // Kitchen staff can cancel an item from their station ticket; the order service still records the void and audit log.
  const kitchenCancelPending = await Tenant.find({ 'settings.kitchenCancelPermissionUpgraded': { $ne: true } }).select('_id').lean();
  for (const t of kitchenCancelPending) {
    await Role.updateMany({ tenantId: t._id, key: 'chef' }, { $addToSet: { permissions: P.ORDERS_VOID_SENT_ITEM } });
    await Tenant.updateOne({ _id: t._id }, { $set: { 'settings.kitchenCancelPermissionUpgraded': true } });
  }

  // Sidebar navigation is a role permission; waiters remain focused on table selection unless an admin grants access.
  const sidebarPending = await Tenant.find({ 'settings.sidebarPermissionUpgraded': { $ne: true } }).select('_id').lean();
  for (const t of sidebarPending) {
    await Role.updateMany({ tenantId: t._id, key: { $ne: 'waiter' } }, { $addToSet: { permissions: P.SIDEBAR_VIEW } });
    await Tenant.updateOne({ _id: t._id }, { $set: { 'settings.sidebarPermissionUpgraded': true } });
  }

  // Cashiers must be able to receive payments on existing installations, as on new cashier roles.
  const cashierPaymentsPending = await Tenant.find({ 'settings.cashierPaymentsUpgraded': { $ne: true } }).select('_id').lean();
  for (const t of cashierPaymentsPending) {
    await Role.updateMany({ tenantId: t._id, key: 'cashier' }, { $addToSet: { permissions: P.PAYMENTS_RECEIVE } });
    await Tenant.updateOne({ _id: t._id }, { $set: { 'settings.cashierPaymentsUpgraded': true } });
  }
}
