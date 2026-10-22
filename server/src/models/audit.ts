import { Schema, model } from 'mongoose';

/** Append-only audit trail. tenantId is null for platform-level actions. */
const auditLogSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, index: true, default: null },
    branchId: Schema.Types.ObjectId,
    actorId: Schema.Types.ObjectId,
    actorName: String,
    action: { type: String, required: true, index: true },
    entity: String,
    entityId: String,
    reason: String,
    approvedBy: Schema.Types.ObjectId,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    meta: Schema.Types.Mixed,
    ip: String,
    requestId: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  auditLogSchema.pre(op, function () {
    throw new Error('Audit log entries are immutable');
  });
}
export const AuditLog = model('AuditLog', auditLogSchema);

/** Generic background job queue (MongoDB-backed, no Redis required). */
const jobSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, default: null },
    type: { type: String, required: true },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'dead'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: Date.now },
    lockedAt: Date,
    lastError: String,
    dedupeKey: String,
    result: Schema.Types.Mixed,
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
jobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: 'done' } });
export const Job = model('Job', jobSchema);
