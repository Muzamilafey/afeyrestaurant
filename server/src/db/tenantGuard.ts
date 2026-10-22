import type { Schema, Query, Aggregate } from 'mongoose';

const QUERY_OPS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'countDocuments', 'replaceOne', 'distinct',
] as const;

export class TenantGuardError extends Error {}

/**
 * Defence in depth for multi-tenancy: any query on a tenant-owned collection must filter by tenantId.
 * Platform-level code that legitimately spans tenants must opt out explicitly with { skipTenantGuard: true }.
 */
export function tenantGuardPlugin(schema: Schema) {
  if (!schema.path('tenantId')) return;
  for (const op of QUERY_OPS) {
    schema.pre(op as any, function (this: Query<unknown, unknown>) {
      const opts = this.getOptions() as { skipTenantGuard?: boolean };
      if (opts.skipTenantGuard) return;
      const filter = this.getFilter();
      if (filter.tenantId === undefined) {
        throw new TenantGuardError(`Unscoped ${op} on ${(this.model as any).modelName}: tenantId filter is required`);
      }
    });
  }
  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if ((this.options as { skipTenantGuard?: boolean }).skipTenantGuard) return;
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!first?.$match || first.$match.tenantId === undefined) {
      throw new TenantGuardError('Aggregations on tenant collections must start with $match on tenantId');
    }
  });
}
