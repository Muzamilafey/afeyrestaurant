import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { schemaOpts, tenantRef, money } from './common';

const branchSchema = new Schema(
  {
    tenantId: tenantRef,
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    address: String,
    phone: String,
    email: String,
    active: { type: Boolean, default: true },
    settings: {
      serviceChargeBps: { type: Number, default: 0 },
      serviceChargeModes: { type: [String], default: ['dine_in'] },
      receiptPrefix: { type: String, default: 'RC' },
      orderPrefix: { type: String, default: 'ORD' },
      enabledModes: { type: [String], default: ['dine_in', 'takeaway', 'delivery', 'bar_counter'] },
      roomServiceEnabled: { type: Boolean, default: false },
      deliveryFee: { ...money },
      openingTime: String,
      closingTime: String,
      kitchenDelayMinutes: { type: Number, default: 15 },
      happyHours: [{ days: [Number], start: String, end: String, discountBps: Number, categoryIds: [Schema.Types.ObjectId] }],
    },
  },
  schemaOpts,
);
branchSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Branch = model('Branch', branchSchema);
export type BranchDoc = HydratedDocument<InferSchemaType<typeof branchSchema>>;

const roleSchema = new Schema(
  {
    tenantId: tenantRef,
    key: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    permissions: [{ type: String }],
    branchScoped: { type: Boolean, default: true },
    system: { type: Boolean, default: false },
  },
  schemaOpts,
);
roleSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Role = model('Role', roleSchema);

const userSchema = new Schema(
  {
    tenantId: tenantRef,
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: String,
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    /** Quick POS PIN for manager approvals (argon2 hash). */
    pinHash: { type: String, select: false },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    branchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }],
    defaultBranchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    active: { type: Boolean, default: true },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
    },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    tokenVersion: { type: Number, default: 0 },
  },
  schemaOpts,
);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ email: 1 });
export const User = model('User', userSchema);
export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedBy: String,
    userAgent: String,
    ip: String,
  },
  schemaOpts,
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const RefreshToken = model('RefreshToken', refreshTokenSchema);

const terminalSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true },
    deviceKey: { type: String, required: true },
    /** SHA-256 of the terminal token stored on the device; enables PIN sign-in on that device only. */
    tokenHash: { type: String },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastSeenAt: Date,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
terminalSchema.index({ tenantId: 1, deviceKey: 1 }, { unique: true });
terminalSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });
export const Terminal = model('Terminal', terminalSchema);

const employeeSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    employeeNo: { type: String, required: true },
    name: { type: String, required: true },
    phone: String,
    email: String,
    jobTitle: String,
    hourlyRate: { type: Number, default: 0 },
    /** The user ID/PIN the employee is registered under on biometric terminals. */
    deviceUserCode: String,
    active: { type: Boolean, default: true },
    biometricConsent: {
      given: { type: Boolean, default: false },
      at: Date,
      withdrawnAt: Date,
      recordedBy: Schema.Types.ObjectId,
      noticeVersion: String,
    },
  },
  schemaOpts,
);
employeeSchema.index({ tenantId: 1, employeeNo: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1, deviceUserCode: 1 }, { unique: true, partialFilterExpression: { deviceUserCode: { $type: 'string' } } });
export const Employee = model('Employee', employeeSchema);

/** Atomic counters for human readable order/receipt numbers. */
const counterSchema = new Schema({
  tenantId: tenantRef,
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);
