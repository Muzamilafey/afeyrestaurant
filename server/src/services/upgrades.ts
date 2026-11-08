import { Role, Tenant } from '../models';
import { PERMISSIONS as P } from '../auth/permissions';

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
}
