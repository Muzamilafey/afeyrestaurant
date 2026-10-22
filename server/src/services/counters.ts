import type { ClientSession, Types } from 'mongoose';
import { Counter } from '../models';

export async function nextSeq(tenantId: Types.ObjectId, key: string, session?: ClientSession) {
  const c = await Counter.findOneAndUpdate({ tenantId, key }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return c!.seq;
}

/** e.g. ORD-MAIN-000123 */
export async function nextNumber(tenantId: Types.ObjectId, prefix: string, scope: string, session?: ClientSession, pad = 6) {
  const n = await nextSeq(tenantId, `${prefix}:${scope}`, session);
  return `${prefix}-${scope}-${String(n).padStart(pad, '0')}`;
}
