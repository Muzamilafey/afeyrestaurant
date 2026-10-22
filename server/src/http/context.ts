import type { Types } from 'mongoose';
import type { Permission } from '../auth/permissions';

export interface RequestContext {
  userId: Types.ObjectId;
  userName: string;
  email: string;
  /** The business id (single-tenant installation) — still used as the scoping key on every query. */
  tenantId: Types.ObjectId;
  /** Active branch for this request (X-Branch-Id header, validated). */
  branchId: Types.ObjectId | null;
  /** Branches the user may act on. */
  allowedBranchIds: Types.ObjectId[];
  allBranches: boolean;
  permissions: Set<Permission>;
  roleKey: string | null;
}

export type TenantContext = RequestContext;
export interface BranchContext extends TenantContext {
  branchId: Types.ObjectId;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      ctx?: RequestContext;
      bridge?: { id: Types.ObjectId; tenantId: Types.ObjectId; branchId: Types.ObjectId };
    }
  }
}
