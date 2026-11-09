import type { Types } from 'mongoose';
import { User } from '../models';
import { verifyPassword } from '../auth/password';

/** PIN-only sign-in needs every staff PIN in a business to identify one account. */
export async function pinAlreadyAssigned(tenantId: Types.ObjectId, pin: string, exceptUserId?: Types.ObjectId): Promise<boolean> {
  const users = await User.find({
    tenantId,
    pinHash: { $exists: true, $ne: null },
    ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}),
  }).select('+pinHash').lean();
  for (const user of users) {
    if (user.pinHash && await verifyPassword(user.pinHash, pin)) return true;
  }
  return false;
}
