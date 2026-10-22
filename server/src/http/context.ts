import type { Types } from 'mongoose';
import type { Permission } from '../auth/permissions';

export interface RequestContext {
  userId: Types.ObjectId;
  userName: string;
  email: string;
  tenantId: Types.ObjectId | null;
  /** Active branch for this request (X-Branch-Id header, validated). */
  branchId: Types.ObjectId | null;
  /** Branches the user may act on. */
  allowedBranchIds: Types.ObjectId[];
  allBranches: boolean;
  permissions: Set<Permission>;
  roleKey: string | null;
  isPlatformAdmin: boolean;
  features: Set<string>;
}

/** Tenant-scoped context guaranteed to have a tenant and branch. */
export interface TenantContext extends RequestContext {
  tenantId: Types.ObjectId;
}
export interface BranchContext extends TenantContext {
  branchId: Types.ObjectId;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      ctx?: RequestContext;
      hostTenantId?: Types.ObjectId | null;
      bridge?: { id: Types.ObjectId; tenantId: Types.ObjectId; branchId: Types.ObjectId };
    }
  }
}
